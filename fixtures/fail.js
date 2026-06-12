// Test fixture: write to both streams and exit nonzero.
process.stdout.write("partial output");
process.stderr.write("something went wrong");
process.exit(3);
