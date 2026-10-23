//! Pulls the schema of a live PostgreSQL database, such as a Supabase project, and turns it
//! into Prisma schema text. Only the catalog is read: no table data, and nothing is written.

use prismagram_core::introspect::{self, Catalog};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{ring, CryptoProvider};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tokio_postgres::config::{Host, SslMode};
use tokio_postgres::error::SqlState;
use tokio_postgres::{Client, Config, NoTls, SimpleQueryMessage};
use tokio_postgres_rustls::MakeRustlsConnect;

/// What Supabase shows in its connection strings until you paste your own password.
const PASSWORD_PLACEHOLDER: &str = "[YOUR-PASSWORD]";

/// URL options tokio-postgres understands. Others, such as Prisma's `pgbouncer=true` or
/// `connection_limit`, are dropped because tokio-postgres rejects unknown options.
const KEPT_OPTIONS: &[&str] = &[
    "user",
    "password",
    "dbname",
    "options",
    "application_name",
    "connect_timeout",
    "target_session_attrs",
    "channel_binding",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pulled {
    pub schema: String,
    /// Host and database name, without credentials.
    pub source: String,
    pub tables: usize,
    pub views: usize,
    pub enums: usize,
}

enum Tls {
    Off,
    /// Encrypted, but the certificate isn't checked: libpq's `sslmode=require`, and what
    /// `psql` and Prisma do by default.
    Unverified,
    /// `sslmode=verify-full`: the certificate must chain to a public root or `sslrootcert`.
    Verified {
        root_cert: Option<String>,
    },
}

struct Target {
    config: Config,
    tls: Tls,
    host: String,
    supabase: bool,
    source: String,
}

pub async fn pull(url: &str, password: &str, schemas: &[String]) -> Result<Pulled, String> {
    let target = parse_target(url, password)?;
    let mut schemas: Vec<String> = schemas
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    schemas.dedup();
    if schemas.is_empty() {
        schemas.push("public".into());
    }

    let work = async {
        let client = connect(&target).await?;
        let catalog = read_catalog(&client, &schemas).await?;
        if catalog.tables.is_empty() && catalog.enums.is_empty() {
            return Err(no_tables_message(&client, &schemas).await);
        }
        Ok(catalog)
    };
    let catalog = tokio::time::timeout(Duration::from_secs(60), work)
        .await
        .map_err(|_| format!("{} took longer than a minute to answer.", target.host))?
        .map_err(|e| e.to_string())?;

    let views = catalog.tables.iter().filter(|t| t.kind == "view").count();
    Ok(Pulled {
        schema: introspect::to_prisma(&catalog, &target.source),
        source: target.source,
        tables: catalog.tables.len() - views,
        views,
        enums: catalog.enums.len(),
    })
}

fn parse_target(input: &str, password: &str) -> Result<Target, String> {
    let mut url = unquote(input.trim()).to_string();
    // A whole `DATABASE_URL="postgres://..."` line copied from a .env file.
    if let Some((key, value)) = url.split_once('=') {
        let value = unquote(value.trim());
        if key
            .trim()
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
            && is_url(value)
        {
            url = value.to_string();
        }
    }
    if url.is_empty() {
        return Err("Paste a connection string first.".into());
    }
    if url.contains(PASSWORD_PLACEHOLDER) {
        if password.is_empty() {
            return Err(format!(
                "Replace {PASSWORD_PLACEHOLDER} in the connection string with your database password, or type it in the Password field."
            ));
        }
        url = url.replace(PASSWORD_PLACEHOLDER, "");
    }

    let mut sslmode = None;
    let mut root_cert = None;
    if is_url(&url) {
        if let Some((base, query)) = url.clone().split_once('?') {
            let mut kept = Vec::new();
            for pair in query.split('&').filter(|p| !p.is_empty()) {
                let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
                match key {
                    "sslmode" => sslmode = Some(percent_decode(value)),
                    "sslrootcert" => root_cert = Some(percent_decode(value)),
                    _ if KEPT_OPTIONS.contains(&key) => kept.push(pair),
                    _ => {}
                }
            }
            url = if kept.is_empty() {
                base.to_string()
            } else {
                format!("{base}?{}", kept.join("&"))
            };
        }
    }

    let mut config: Config = url
        .parse()
        .map_err(|e| format!("Could not read the connection string: {e}"))?;
    if !password.is_empty() {
        config.password(password);
    }
    if config.get_user().is_none() {
        return Err("The connection string has no user name.".into());
    }
    config.application_name("Prismagram");
    config.connect_timeout(Duration::from_secs(15));

    let host = match config.get_hosts().first() {
        Some(Host::Tcp(host)) => host.clone(),
        #[cfg(unix)]
        Some(Host::Unix(path)) => path.display().to_string(),
        None => "localhost".into(),
    };
    let supabase = host.ends_with(".supabase.co") || host.ends_with(".supabase.com");
    // A `host=... sslmode=...` string was parsed by tokio-postgres itself.
    let sslmode = sslmode.or_else(|| {
        let mode = match config.get_ssl_mode() {
            SslMode::Disable => "disable",
            SslMode::Require => "require",
            _ => "prefer",
        };
        (!is_url(&url)).then(|| mode.to_string())
    });
    let (tls, mode) = match sslmode.as_deref() {
        Some("disable") => (Tls::Off, SslMode::Disable),
        Some("verify-full" | "verify-ca") => (Tls::Verified { root_cert }, SslMode::Require),
        // Supabase always offers TLS, so never fall back to plain text there.
        Some("allow" | "prefer") | None if !supabase => (Tls::Unverified, SslMode::Prefer),
        Some("allow" | "prefer" | "require") | None => (Tls::Unverified, SslMode::Require),
        Some(other) => return Err(format!("Unknown sslmode `{other}`.")),
    };
    config.ssl_mode(mode);

    let source = format!("{host}/{}", config.get_dbname().unwrap_or("postgres"));
    Ok(Target {
        config,
        tls,
        host,
        supabase,
        source,
    })
}

async fn connect(target: &Target) -> Result<Client, String> {
    let explain = |e: tokio_postgres::Error| explain(&e, target);
    let client = match &target.tls {
        Tls::Off => {
            let (client, connection) = target.config.connect(NoTls).await.map_err(explain)?;
            tauri::async_runtime::spawn(connection);
            client
        }
        tls => {
            let tls = MakeRustlsConnect::new(rustls_config(tls)?);
            let (client, connection) = target.config.connect(tls).await.map_err(explain)?;
            tauri::async_runtime::spawn(connection);
            client
        }
    };
    Ok(client)
}

async fn read_catalog(client: &Client, schemas: &[String]) -> Result<Catalog, String> {
    let messages = client
        .simple_query(&introspect::catalog_query(schemas))
        .await
        .map_err(|e| format!("Could not read the database schema: {}", db_message(&e)))?;
    let json = messages
        .iter()
        .find_map(|m| match m {
            SimpleQueryMessage::Row(row) => row.get(0),
            _ => None,
        })
        .ok_or("The database returned no schema information.")?;
    serde_json::from_str(json).map_err(|e| format!("Could not read the database schema: {e}"))
}

async fn no_tables_message(client: &Client, schemas: &[String]) -> String {
    let sql = "select string_agg(nspname, ', ' order by nspname) from pg_namespace \
               where nspname !~ '^pg_' and nspname <> 'information_schema'";
    let available = client.simple_query(sql).await.ok().and_then(|messages| {
        messages.iter().find_map(|m| match m {
            SimpleQueryMessage::Row(row) => row.get(0).map(str::to_string),
            _ => None,
        })
    });
    let mut message = format!("No tables found in {}.", schemas.join(", "));
    if let Some(available) = available {
        message.push_str(&format!(" Schemas in this database: {available}."));
    }
    message
}

fn rustls_config(tls: &Tls) -> Result<ClientConfig, String> {
    let provider = Arc::new(ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?;
    let config = match tls {
        Tls::Verified { root_cert } => {
            let mut roots = RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            if let Some(path) = root_cert {
                let bytes = std::fs::read(path)
                    .map_err(|e| format!("Could not read sslrootcert {path}: {e}"))?;
                let mut certs: Vec<CertificateDer> = CertificateDer::pem_slice_iter(&bytes)
                    .collect::<Result<_, _>>()
                    .map_err(|e| format!("Could not read sslrootcert {path}: {e}"))?;
                // Not PEM: a binary (DER) certificate.
                if certs.is_empty() {
                    certs.push(CertificateDer::from(bytes));
                }
                for cert in certs {
                    roots
                        .add(cert)
                        .map_err(|e| format!("Could not use sslrootcert {path}: {e}"))?;
                }
            }
            builder.with_root_certificates(roots).with_no_client_auth()
        }
        _ => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(EncryptOnly(provider)))
            .with_no_client_auth(),
    };
    Ok(config)
}

/// Accepts any server certificate but still checks handshake signatures, like libpq's
/// `sslmode=require`. Supabase signs its certificates with its own CA, which no system trusts.
#[derive(Debug)]
struct EncryptOnly(Arc<CryptoProvider>);

impl ServerCertVerifier for EncryptOnly {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// A connection error in words, with a hint for the usual Supabase mistakes.
fn explain(e: &tokio_postgres::Error, target: &Target) -> String {
    let host = &target.host;
    let user = target.config.get_user().unwrap_or("");
    if let Some(db) = e.as_db_error() {
        if db.code() == &SqlState::INVALID_PASSWORD {
            return format!("Wrong password for user {user}.");
        }
        let mut message = format!("{host} refused the connection: {}.", db.message());
        if db.message().contains("Tenant or user not found") {
            message.push_str(" Supabase pooler users look like postgres.<project-ref>: copy the string from Supabase → Connect.");
        }
        return message;
    }
    let mut message = format!("Could not connect to {host}: {}.", db_message(e));
    if !target.supabase {
        return message;
    }
    if host.starts_with("db.") && host.ends_with(".supabase.co") {
        message.push_str(
            " Supabase's direct connection only works over IPv6. Use the Session pooler string from Supabase → Connect instead.",
        );
    } else if matches!(target.tls, Tls::Verified { .. })
        && message.to_lowercase().contains("certificate")
    {
        message.push_str(
            " Supabase signs its certificates with its own CA: download it from Database Settings → SSL and add &sslrootcert=/path/to/prod-supabase.cer.",
        );
    }
    message
}

/// The error with its causes, e.g. "error connecting to server: Connection refused (os error 111)".
fn db_message(e: &tokio_postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        return db.message().to_string();
    }
    let mut message = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(cause) = source {
        message.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    message
}

fn is_url(s: &str) -> bool {
    s.starts_with("postgres://") || s.starts_with("postgresql://")
}

fn unquote(s: &str) -> &str {
    s.trim_matches(|c| c == '"' || c == '\'')
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok());
        match (bytes[i], hex.and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (b'+', _) => {
                out.push(b' ');
                i += 1;
            }
            (byte, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_supabase_strings() {
        let t = parse_target(
            "DATABASE_URL=\"postgresql://postgres.abcd:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1\"",
            "s3cret/#@",
        )
        .unwrap();
        assert_eq!(t.config.get_user(), Some("postgres.abcd"));
        assert_eq!(t.config.get_password(), Some(&b"s3cret/#@"[..]));
        assert_eq!(t.source, "aws-0-eu-west-1.pooler.supabase.com/postgres");
        assert_eq!(t.config.get_ssl_mode(), SslMode::Require);
        assert!(matches!(t.tls, Tls::Unverified));
    }

    #[test]
    fn placeholder_needs_a_password() {
        let err = parse_target(
            "postgresql://postgres:[YOUR-PASSWORD]@db.abcd.supabase.co:5432/postgres",
            "",
        )
        .err()
        .unwrap();
        assert!(err.contains("[YOUR-PASSWORD]"), "{err}");
    }

    #[test]
    fn sslmode_options() {
        let t = parse_target("postgres://me:pw@localhost/app", "").unwrap();
        assert_eq!(t.config.get_ssl_mode(), SslMode::Prefer);
        let t = parse_target("postgres://me:pw@localhost/app?sslmode=disable", "").unwrap();
        assert!(matches!(t.tls, Tls::Off));
        let t = parse_target(
            "postgres://me:pw@x.pooler.supabase.com/postgres?sslmode=verify-full&sslrootcert=%2Ftmp%2Fca.cer",
            "",
        )
        .unwrap();
        assert!(matches!(t.tls, Tls::Verified { root_cert: Some(ref p) } if p == "/tmp/ca.cer"));
        assert_eq!(t.config.get_ssl_mode(), SslMode::Require);
        assert!(parse_target("postgres://me@localhost/app?sslmode=bogus", "").is_err());
    }

    /// `PRISMAGRAM_TEST_DATABASE_URL=postgres://... cargo test -- --ignored`
    #[test]
    #[ignore = "needs a database in PRISMAGRAM_TEST_DATABASE_URL"]
    fn pulls_a_live_database() {
        let url = std::env::var("PRISMAGRAM_TEST_DATABASE_URL").unwrap();
        let pulled = tauri::async_runtime::block_on(pull(&url, "", &["public".into()])).unwrap();
        let schema = prismagram_core::parse(&pulled.schema);
        assert!(pulled.tables > 0, "{}", pulled.schema);
        assert!(
            schema.diagnostics.is_empty(),
            "{:?}\n{}",
            schema.diagnostics,
            pulled.schema
        );
    }
}
