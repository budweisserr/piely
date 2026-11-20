use super::*;

#[test]
fn test_move_window_state_default() {
    let state = MoveWindowState::default();
    assert!(state.tasks.lock().unwrap().is_empty());
}
