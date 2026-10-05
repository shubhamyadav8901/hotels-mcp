import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

// Node tries a host's IPv4 and IPv6 addresses in turn, abandoning each attempt after 250 ms, so on a network
// where connecting takes longer (e.g. NAT64, or a slow link: 0.5–5 s seen from Docker) every attempt fails
// with ETIMEDOUT although the host is reachable. Give each attempt 2.5 s. Imported for its side effect by every
// entry point that makes outbound calls.
setDefaultAutoSelectFamilyAttemptTimeout(2_500);
