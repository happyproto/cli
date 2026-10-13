fn main() {
    // The HappyView release asset hpy fetches for this machine is named by the
    // triple hpy itself was built for, which only the build script can see.
    println!(
        "cargo:rustc-env=HPY_TARGET={}",
        std::env::var("TARGET").expect("cargo sets TARGET for build scripts")
    );
    println!("cargo:rerun-if-changed=build.rs");
}
