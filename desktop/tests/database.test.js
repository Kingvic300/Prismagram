// The saved connection string must never keep the password.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPassword, withoutPassword } from "../src/js/database.js";

test("puts the password into a connection string to copy", () => {
  assert.equal(withPassword("postgresql://postgres:[YOUR-PASSWORD]@db.x.supabase.co/postgres", "p@ss/1"), "postgresql://postgres:p%40ss%2F1@db.x.supabase.co/postgres");
  assert.equal(withPassword("mongodb+srv://ann:<db_password>@c0.mongodb.net/", "pw"), "mongodb+srv://ann:pw@c0.mongodb.net/");
  assert.equal(withPassword("postgres://ann@localhost:5432/app", "pw"), "postgres://ann:pw@localhost:5432/app");
  assert.equal(withPassword("postgres://ann:inline@localhost/app", "other"), "postgres://ann:inline@localhost/app");
  assert.equal(withPassword(" postgres://ann@h/db ", ""), "postgres://ann@h/db");
});

test("replaces the password with Supabase's placeholder", () => {
  assert.equal(
    withoutPassword("postgresql://postgres.abcd:s3cr@t:x/y@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"),
    "postgresql://postgres.abcd:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:5432/postgres",
  );
  assert.equal(
    withoutPassword('DATABASE_URL="postgres://me:pw@localhost/app?sslmode=require"'),
    'DATABASE_URL="postgres://me:[YOUR-PASSWORD]@localhost/app?sslmode=require"',
  );
});

test("leaves strings without a password alone", () => {
  for (const url of [
    "postgres://me@localhost/app",
    "postgres://localhost:5432/app",
    "postgresql://postgres:[YOUR-PASSWORD]@db.abcd.supabase.co:5432/postgres",
  ]) {
    assert.equal(withoutPassword(url), url);
  }
});

test("drops key=value and query-string passwords", () => {
  assert.equal(withoutPassword("host=h user=u password='a b' dbname=d"), "host=h user=u password= dbname=d");
  assert.equal(withoutPassword("postgres://me@h/app?password=x&sslmode=require"), "postgres://me@h/app?password=&sslmode=require");
});
