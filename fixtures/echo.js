// Test fixture: echo stdin to stdout, exit 0.
process.stdin.setEncoding("utf8");
let data = "";
for await (const chunk of process.stdin) data += chunk;
process.stdout.write(data);
