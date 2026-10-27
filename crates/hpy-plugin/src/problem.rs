use std::fmt;

/// One thing wrong with a plugin's inputs, located by a field path such as
/// `release.requires["env:happyview"]`. Validation collects these rather than
/// stopping at the first, so an author fixes everything in one pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub path: String,
    pub message: String,
}

impl Problem {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for Problem {
    /// A problem with no path is a whole sentence already, such as one about
    /// a file as a whole that names the file itself.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.path.is_empty() {
            write!(f, "{}", self.message)
        } else {
            write!(f, "{}: {}", self.path, self.message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_problem_without_a_path_prints_only_its_message() {
        assert_eq!(Problem::new("a.b", "is wrong").to_string(), "a.b: is wrong");
        assert_eq!(Problem::new("", "x is wrong").to_string(), "x is wrong");
    }
}
