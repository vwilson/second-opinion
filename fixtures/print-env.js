// Test fixture: print the env vars runAgent is expected to set.
process.stdout.write(
  `extra=${process.env.AGENTMCP_TEST_EXTRA ?? ""};no_color=${process.env.NO_COLOR ?? ""}`
);
