// Thorough event-capability probe for Tapo C236.
// Runs every relevant ONVIF event-related call and dumps the result so we
// can decide whether motion/person/pet/vehicle/line-crossing/tampering/
// baby-crying events are exposed by the camera at all.
const { Cam } = require('onvif');

const HOST = process.env.ONVIF_HOST || '212.253.82.220';
const PORT = parseInt(process.env.ONVIF_PORT || '4020', 10);
const USER = process.env.ONVIF_USER || 'qbitc236';
const PASS = process.env.ONVIF_PASS || 'c236c236';

const cam = new Cam({
  hostname: HOST, port: PORT, username: USER, password: PASS,
  timeout: 20000, preserveAddress: true
}, (err) => {
  if (err) { console.error('connect err:', err.message); process.exit(1); }

  console.log('== capabilities.events ==');
  console.log(JSON.stringify(cam.capabilities?.events || null, null, 2));

  console.log('\n== services ==');
  // getServices lists all advertised services with their XAddr URLs.
  cam.getServices(true, (err, services) => {
    if (err) { console.error('getServices err:', err.message); } else {
      const trimmed = (services || []).map(s => ({
        namespace: s.namespace,
        XAddr: s.XAddr,
        version: s.version
      }));
      console.log(JSON.stringify(trimmed, null, 2));
    }

    console.log('\n== getEventProperties (topic filter dialects, topics) ==');
    cam.getEventProperties((err, props) => {
      if (err) {
        console.error('getEventProperties err:', err.message);
      } else {
        // topicSet is a nested tree — print a flat list of leaf topic names
        // so we can tell at a glance which events the camera exposes.
        const topics = [];
        function walk(node, path) {
          if (!node || typeof node !== 'object') return;
          for (const key of Object.keys(node)) {
            if (key === '$' || key === 'messageDescription') continue;
            const sub = node[key];
            const newPath = path ? `${path}/${key}` : key;
            if (sub && typeof sub === 'object' && (sub.messageDescription || sub.$?.['wstop:topic'] === 'true' || sub.$?.topic === 'true')) {
              topics.push(newPath);
            }
            walk(sub, newPath);
          }
        }
        walk(props.topicSet, '');
        console.log('leaf topics:', topics.length ? topics : '(none found)');
        console.log('\nfull topicSet dump:');
        console.log(JSON.stringify(props.topicSet, null, 2));
      }

      console.log('\n== try manual CreatePullPointSubscription ==');
      // Some Tapo firmwares need this called explicitly instead of via the
      // newListener hook. If it succeeds we get a subscription ref with a
      // SubscriptionReference.Address we can pull from.
      cam.createPullPointSubscription((err, sub) => {
        if (err) {
          console.error('createPullPointSubscription err:', err.message);
        } else {
          console.log('subscription created:', JSON.stringify(sub, null, 2));

          console.log('\n== pulling messages (30s timeout) ==');
          cam.pullMessages({ timeout: 'PT30S', messageLimit: 10 }, (err, messages) => {
            if (err) { console.error('pullMessages err:', err.message); }
            else { console.log('pulled:', JSON.stringify(messages, null, 2)); }
            process.exit(0);
          });
          // Safety exit — pullMessages may hang forever on some firmwares.
          setTimeout(() => { console.log('(pullMessages timed out after 35s)'); process.exit(0); }, 35000);
          return;
        }
        process.exit(0);
      });
    });
  });
});
