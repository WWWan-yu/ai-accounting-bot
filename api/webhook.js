const line = require('@line/bot-sdk');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const greetings = ['早安', '午安', '晚安', '你好', 'hi', 'hello', '嗨', '安安'];
const queries = ['今天花了多少', '今天花多少', '本月花了多少', '本月花多少', '這個月花了多少', '這個月花多少', '我花了多少', '花了多少'];

const funnyReplies = [
  '好的，幫你記下來了！錢錢辛苦了～💸',
  '記好了！雖然心疼但還是幫你記上去了 😅',
  '已記帳！下次要省一點喔 🥺',
  '收到！你今天花得很開心嗎？😊',
  '幫你記好了！錢包說它需要休息一下 👛',
  '記帳完成！每一分錢都要花得值得哦 ✨',
];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'ok' });
  }

  const events = req.body?.events;
  if (!events || events.length === 0) {
    return res.status(200).json({ status: 'ok' });
  }

  const event = events[0];
  if (event.type !== 'message' || !event.message?.text) {
    return res.status(200).json({ status: 'ok' });
  }

  const userMsg = event.message.text.trim();
  const replyToken = event.replyToken;

  try {
    // 問候
    if (greetings.some(g => userMsg.toLowerCase().includes(g))) {
      const hour = new Date().getHours();
      let greeting = hour < 12 ? '早安' : hour < 18 ? '午安' : '晚安';
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `${greeting}！今天也要好好記帳喔 💕\n有花錢就告訴我，我幫你顧好荷包！`
      });
      return res.status(200).json({ status: 'ok' });
    }

    // 查詢花費
    if (queries.some(q => userMsg.includes(q))) {
      const result = await querySpending(userMsg);
      await client.replyMessage(replyToken, { type: 'text', text: result });
      return res.status(200).json({ status: 'ok' });
    }

    // 補充模式：. 開頭
    if (userMsg.startsWith('.')) {
      const content = userMsg.slice(1).trim();
      const parts = content.split(/[,，\s]+/);
      const storeName = parts[0] || '';
      const rating = parts[1] || '';
      const note = parts.slice(2).join(' ') || '';

      await updateLastRow({ storeName, rating, note });

      await client.replyMessage(replyToken, {
        type: 'text',
        text: `好的，幫你補上了！🏪 ${storeName || '—'} ⭐ ${rating || '—'} 📌 ${note || '—'}`
      });
      return res.status(200).json({ status: 'ok' });
    }

    // 上班開銷：# 開頭
    if (userMsg.startsWith('#')) {
      const content = userMsg.slice(1).trim();
      const numMatch = content.match(/\d+/);
      const 金額 = numMatch ? Number(numMatch[0]) : 0;
      const 品項 = content.replace(/\d+/g, '').trim();

      await writeToSheet({ 品項, 金額, 類別: '上班開銷', sheetName: '上班開銷' });

      await client.replyMessage(replyToken, {
        type: 'text',
        text: `💼 上班開銷記好了！\n📝 ${品項}\n💰 NT$${金額}\n\n辛苦了，上班賺錢不容易 💪`
      });
      return res.status(200).json({ status: 'ok' });
    }

    // 一般記帳
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `請從以下句子中找出消費品項和金額。
規則：
1. 只回傳JSON，不要任何其他文字
2. 金額必須是純數字（例如1580），不是字串
3. 如果找不到金額就填0
4. 品項只留商品或活動名稱，完全不能包含任何數字或金額
5. 類別從以下選一個：食品、交通、娛樂、公司相關、美容、購物

回傳格式：{"品項":"xxx","金額":數字,"類別":"xxx"}

句子：${userMsg}`
            }]
          }]
        })
      }
    );

    const geminiData = await geminiRes.json();
    let parsed;
    try {
      const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const clean = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      parsed = { 品項: userMsg, 金額: 0, 類別: '食品' };
    }

    const 品項 = (parsed['品項'] || userMsg).replace(/\d+/g, '').trim();
    const numMatch = userMsg.match(/\d+/);
    const 金額 = numMatch ? Number(numMatch[0]) : (Number(parsed['金額']) || 0);
    const 類別 = detectCategory(userMsg) || parsed['類別'] || '食品';

    await writeToSheet({ 品項, 金額, 類別, sheetName: '流水帳' });

    const randomReply = funnyReplies[Math.floor(Math.random() * funnyReplies.length)];

    await client.replyMessage(replyToken, {
      type: 'text',
      text: `${randomReply}\n📝 ${品項}\n💰 NT$${金額}\n🏷️ ${類別}\n\n想補充店名/評價/備註嗎？\n格式：. 店名 評價 備註`
    });

    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    console.error(err);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '哎呀出錯了，再說一次給我聽？🙏'
    });
    return res.status(200).json({ status: 'error' });
  }
};

function detectCategory(text) {
  const rules = [
    { keywords: ['飯','麵','便當','火鍋','飲料','咖啡','茶','水果','零食','餅','冰','湯','肉','蛋','菜','早餐','午餐','晚餐','宵夜','吃','喝','食','滷','蛋糕','甜點','麵包'], category: '食品' },
    { keywords: ['捷運','公車','計程車','uber','油','停車','高鐵','台鐵','火車','機票','交通','車錢','車費'], category: '交通' },
    { keywords: ['電影','ktv','遊戲','旅遊','景點','門票','唱歌','玩','娛樂','酒','夜市','展覽'], category: '娛樂' },
    { keywords: ['pla','耗材','線材','樹脂','拓竹','bambu','filament','材料','印表機','3d','工具','機器','設備','零件'], category: '公司相關' },
    { keywords: ['剪髮','剪頭髮','美甲','美睫','按摩','spa','美容','護膚','染髮','燙髮','做臉'], category: '美容' },
    { keywords: ['衣','褲','鞋','包','3c','手機','電腦','日用品','清潔','衛生','購物','買東西'], category: '購物' },
  ];
  const lower = text.toLowerCase();
  for (const rule of rules) {
    if (rule.keywords.some(k => lower.includes(k.toLowerCase()))) {
      return rule.category;
    }
  }
  return '食品';
}

async function getDoc() {
  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();
  return doc;
}

async function writeToSheet(data) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[data.sheetName];
  const today = new Date().toLocaleDateString('zh-TW');
  await sheet.addRow({
    日期: today,
    品項: data.品項,
    金額: data.金額,
    類別: data.類別,
    店名: '',
    評價: '',
    備註: '',
  });
}

async function updateLastRow({ storeName, rating, note }) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle['流水帳'];
  const rows = await sheet.getRows();
  const lastRow = rows[rows.length - 1];
  if (lastRow) {
    if (storeName) lastRow['店名'] = storeName;
    if (rating) lastRow['評價'] = rating;
    if (note) lastRow['備註'] = note;
    await lastRow.save();
  }
}

async function querySpending(msg) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle['流水帳'];
  const rows = await sheet.getRows();
  const now = new Date();
  const todayStr = now.toLocaleDateString('zh-TW');
  const thisMonth = `${now.getFullYear()}/${now.getMonth() + 1}`;

  const isToday = msg.includes('今天');
  let total = 0;
  let count
