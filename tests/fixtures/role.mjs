// e2e 用の役割プロセス。argv に目印（agent-console-e2e-role）を持つので、sh が exec しても ps の command に残る。
console.log(`READY ${process.cwd()}`);
process.stdin.pipe(process.stdout);
