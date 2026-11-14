// TS-only: the proxy settings reqwest read from the environment for every Rust request
// (hyper-util 0.1.21 `Matcher::from_env`), as handed to Node's `setGlobalProxyFromEnv`.
import { expect, it } from "vitest";
import { proxyEnv } from "../../src/atproto/http.ts";

it("proxies_come_from_the_environment_as_reqwest_reads_them", () => {
  expect(proxyEnv({})).toBeUndefined();
  expect(proxyEnv({ HTTPS_PROXY: "" })).toBeUndefined();
  expect(proxyEnv({ HTTPS_PROXY: "http://p:1" })).toEqual({
    HTTPS_PROXY: "http://p:1",
    NO_PROXY: "",
  });
  // ALL_PROXY covers both schemes; a specific one wins over it; a bare host:port is http://.
  expect(proxyEnv({ all_proxy: "p:2", http_proxy: "http://h:3", no_proxy: "x.test" })).toEqual({
    HTTP_PROXY: "http://h:3",
    HTTPS_PROXY: "http://p:2",
    NO_PROXY: "x.test",
  });
  // The upper-case name wins when set, even empty.
  expect(proxyEnv({ HTTPS_PROXY: "", https_proxy: "http://l:4" })).toBeUndefined();
  expect(proxyEnv({ HTTPS_PROXY: "http://u:5", https_proxy: "http://l:4" })?.HTTPS_PROXY).toBe(
    "http://u:5",
  );
});
