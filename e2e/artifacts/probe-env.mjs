console.log(JSON.stringify(Object.entries(process.env).filter(([k]) => /ELECTRON|NODE|PLAYWRIGHT|SESSION|CHROME|DEBUG/i.test(k)).sort()));
process.exit(0);
