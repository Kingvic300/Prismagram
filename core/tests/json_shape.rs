//! The desktop frontend reads the parser output as JSON, so its field names are part of the contract.

#[test]
fn serializes_with_camel_case_keys() {
    let schema = prismagram_core::parse(
        "model User {\n  id    Int    @id\n  posts Post[]\n}\nmodel Post {\n  id       Int  @id\n  author   User @relation(fields: [authorId], references: [id])\n  authorId Int\n}\n",
    );
    let json = serde_json::to_value(&schema).unwrap();
    let field = &json["models"][0]["fields"][0];
    assert_eq!(field["typeName"], "Int");
    assert_eq!(field["isId"], true);
    let relation = &json["relations"][0];
    assert_eq!(relation["parentMultiplicity"], "1");
    assert_eq!(relation["childMultiplicity"], "*");
    assert_eq!(relation["kind"], "one-to-many");
}
