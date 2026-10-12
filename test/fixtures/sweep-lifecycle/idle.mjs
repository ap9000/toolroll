process.on('SIGTERM', () => {});
process.on('message', () => {});
setInterval(() => {}, 1000);
process.send('ready');
