# Rust ownership

In Rust, each value has an owner. When the owner goes out of scope, the value is dropped. Borrowing allows a reference to access a value without taking ownership.

```rust
let message = String::from("Hello");
let borrowed = &message;
```
