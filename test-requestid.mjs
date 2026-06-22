// Test the requestId fallback matching logic
const pending = new Map();
pending.set(1, { resolve: () => console.log('OK: would have resolved'), reject: () => {} });

const responseText = '{"protocolVersion":"0.3.0","requestId":0,"sessionId":"x","success":true,"state":"idle","result":"{}","error":"null"}\n';

const response = JSON.parse(responseText.trim());
console.log('Response requestId:', response.requestId);
console.log('Pending keys:', [...pending.keys()]);

let match = pending.get(response.requestId);
if (!match && response.requestId === 0 && pending.size === 1) {
    const sole = pending.entries().next();
    if (!sole.done) {
        match = sole.value[1];
        console.log('FALLBACK matched -> routing to pending', sole.value[0]);
    }
}
if (match) {
    console.log('PASS: dispatch would succeed');
} else {
    console.log('FAIL: dispatch would timeout');
}
