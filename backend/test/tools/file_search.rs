use super::*;

/// The walk lowercases both sides once; this mirrors that for the test.
fn match_score(name: &str, query: &str) -> Option<u32> {
    score_name(&name.to_lowercase(), &query.to_lowercase())
}

#[test]
fn test_match_score_ranks_exact_above_fuzzy() {
    let exact = match_score("budget.xlsx", "budget").expect("exact match");
    let fuzzy = match_score("b-u-d-g-e-t-notes.txt", "budget").expect("fuzzy match");
    assert!(exact < fuzzy, "exact {} fuzzy {}", exact, fuzzy);
    assert_eq!(match_score("holiday.jpg", "budget"), None);
}
