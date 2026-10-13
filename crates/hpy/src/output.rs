/// Human text to stderr; the result to stdout — as JSON with `--json`.
pub struct Output {
    json: bool,
}

impl Output {
    pub fn new(json: bool) -> Output {
        Output { json }
    }

    // Only `dev --network local` asks, and it is unix-only.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub fn is_json(&self) -> bool {
        self.json
    }

    pub fn status(&self, msg: &str) {
        eprintln!("{msg}");
    }

    pub fn done(&self, human: &str, json: serde_json::Value) {
        if self.json {
            println!("{}", serde_json::to_string_pretty(&json).expect("json"));
        } else if !human.is_empty() {
            println!("{human}");
        }
    }
}
