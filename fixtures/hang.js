// Test fixture: never exits on its own (stdin is deliberately not consumed).
process.stdout.write("started");
setInterval(() => {}, 1_000);
