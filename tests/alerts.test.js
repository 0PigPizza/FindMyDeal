const test=require('node:test');
const assert=require('node:assert/strict');
const alerts=require('../alerts');
test('validates supported destination details',()=>{
 assert.deepEqual(alerts.validate('discord',{webhook:'https://discord.com/api/webhooks/123/abc-DEF'}),{webhook:'https://discord.com/api/webhooks/123/abc-DEF'});
 assert.throws(()=>alerts.validate('discord',{webhook:'https://discord.com.evil.example/api/webhooks/123/token'}));
 assert.deepEqual(alerts.validate('telegram',{token:'123:abc_DEF',chatId:'-100123'}),{token:'123:abc_DEF',chatId:'-100123'});
 assert.throws(()=>alerts.validate('telegram',{token:'bad',chatId:'123'}));
});
test('sends destination-specific messages and suppresses Discord mentions',async()=>{
 const original=global.fetch;const calls=[];global.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true};};
 try{await alerts.send('discord',{webhook:'https://discord.com/api/webhooks/123/token'},'@everyone deal');await alerts.send('telegram',{token:'123:token',chatId:'-123'},'deal');assert.deepEqual(calls[0].body.allowed_mentions,{parse:[]});assert.equal(calls[1].body.chat_id,'-123');assert.equal(calls[1].body.text,'deal');}finally{global.fetch=original;}
});
