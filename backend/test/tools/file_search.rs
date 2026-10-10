use super::*;

#[test]
fn test_match_score_ranks_exact_above_fuzzy() {
    let exact = match_score("budget.xlsx", "budget").expect("exact match");
    let fuzzy = match_score("b-u-d-g-e-t-notes.txt", "budget").expect("fuzzy match");
    assert!(exact < fuzzy, "exact {} fuzzy {}", exact, fuzzy);
    assert_eq!(match_score("holiday.jpg", "budget"), None);
}
