# OctoCode maintenance patch

Source: https://github.com/our-forks/async-openai.git
Commit: 95b52ebdedf42143083cf3d6f0e0be7c84e9c808, async-openai 0.33.1.
The complete package source and upstream MIT license are retained.

Replace discontinued backoff/instant with backon, already used in OctoCode.
Retain retries for API 5xx and non-quota 429 errors. Request construction,
transport, malformed responses, permanent API errors and quota exhaustion
still return immediately. The default delay starts at 500 ms, grows by 1.5,
caps at 60 seconds and has a 15 minute cumulative delay budget with jitter.
Backon's jitter distribution differs from the previous crate.

Client::build and with_backoff now accept backon::ExponentialBuilder.
No OctoCode caller passes the previous backoff type. Other API, request,
response and fork behavior is preserved. Retry status tests use a local server.
