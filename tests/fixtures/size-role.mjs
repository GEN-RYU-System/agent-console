// e2e 用の役割プロセス（端末の大きさを観測する）。起動時と、大きさが変わる（SIGWINCH）たびに `SIZE <cols>x<rows>` を出す。
// argv に目印（agent-console-e2e-role）を持つので、ps の command に残る。
console.log(`READY ${process.cwd()}`);
const report = () => console.log(`SIZE ${process.stdout.columns}x${process.stdout.rows}`);
report();
process.stdout.on("resize", report);
process.stdin.resume();
