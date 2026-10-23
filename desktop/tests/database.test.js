// The saved connection string must never keep the password.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutPassword } from "../src/js/database.js";

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
