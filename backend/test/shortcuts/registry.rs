use super::*;

#[test]
fn test_validate_shortcut_key() {
    assert!(validate_shortcut_key("CommandOrControl+Shift+Space".to_string()).unwrap());
    assert!(validate_shortcut_key("Alt+X".to_string()).unwrap());
    assert!(!validate_shortcut_key("NotAValidKeyCombination".to_string()).unwrap());
}
