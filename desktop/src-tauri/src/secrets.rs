//! Saved connections' secrets. The connection string and password of each saved connection
//! are kept in the operating system's keychain, encrypted by it and unlocked with the user's
//! login; only a copy without the password is kept in the app's own storage, to list it.

use serde::{Deserialize, Serialize};

const SERVICE: &str = "io.github.kingvic300.prismagram";

#[derive(Serialize, Deserialize)]
pub struct Secret {
    pub url: String,
    pub password: String,
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(message)
}

pub fn save(account: &str, secret: &Secret) -> Result<(), String> {
    let json = serde_json::to_string(secret).map_err(|e| e.to_string())?;
    entry(account)?.set_password(&json).map_err(message)
}

/// None when nothing was saved for `account`.
pub fn load(account: &str) -> Result<Option<Secret>, String> {
    match entry(account)?.get_password() {
        Ok(json) => Ok(serde_json::from_str(&json).ok()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(message(e)),
    }
}

pub fn forget(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(message(e)),
    }
}

fn message(e: keyring::Error) -> String {
    format!("The system keychain is not available: {e}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes to the real keychain: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn round_trips_through_the_keychain() {
        let account = "prismagram-test://user@localhost/db";
        let secret = Secret {
            url: "postgres://user:s3cret@localhost/db".into(),
            password: "pw".into(),
        };
        save(account, &secret).unwrap();
        let back = load(account).unwrap().unwrap();
        assert_eq!(
            (back.url.as_str(), back.password.as_str()),
            ("postgres://user:s3cret@localhost/db", "pw")
        );
        forget(account).unwrap();
        assert!(load(account).unwrap().is_none());
        forget(account).unwrap();
    }
}
