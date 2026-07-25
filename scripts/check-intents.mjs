import 'dotenv/config';

const res = await fetch('https://discord.com/api/v10/applications/@me', {
  headers: { Authorization: 'Bot ' + process.env.DISCORD_TOKEN },
});

if (!res.ok) {
  console.log('Token check FAILED:', res.status, await res.text());
  process.exit(1);
}

const app = await res.json();
const f = app.flags ?? 0;
console.log('App name :', app.name);
console.log('App ID   :', app.id);
console.log('Flags    :', f);
console.log('MEMBERS intent enabled     :', !!(f & (1 << 14)) || !!(f & (1 << 15)));
console.log('MSG CONTENT intent enabled :', !!(f & (1 << 18)) || !!(f & (1 << 19)));
console.log('\nPortal page for THIS app:');
console.log(`https://discord.com/developers/applications/${app.id}/bot`);
