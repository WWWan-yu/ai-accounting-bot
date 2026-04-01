const line = require('@line/bot-sdk');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

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
    // 補充模式：. 開頭
    if (userMsg.startsWith('.')) {
      const content = userMsg.slice(1).trim();
      const parts = content.split(/[,，\s]+/);
      const storeName = parts[0] || '';
      const rating = parts[1] || '';
      const note = parts.slice(2).join(' ') || '';
      await updateLastRow({ storeName, rating, note, sheetName: '流水帳' });
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

    // 全部交給 Gemini 判斷
    const geminiRes = await fetch(
 `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `你是王老闆的貼心女助理，負責幫她記帳和聊天。
王老闆是台灣女生，在新北市，個性直接，喜歡被關心。

請判斷這句話是「記帳」還是「聊天」：

如果是記帳（包含金額或消費行為），回傳JSON格式：
{"type":"accounting","品項":"xxx","金額":數字,"類別":"xxx","reply":"記帳後的貼心回覆"}
類別選項：食品、交通、娛樂、公司相關、美容、購物
金額必須是純數字，品項不能包含數字。

如果是聊天、問候、查詢、抱怨、任何非記帳的話，回傳JSON格式：
{"type":"chat","reply":"用貼心女助理的語氣回覆，繁體中文，簡短有溫度，可以加emoji"}

查詢花費時，直接在reply裡說「我幫你查一下」就好，不用實際計算。

只回傳JSON，不要其他文字。

這句話：${userMsg}`
            }]
          }]
        })
      }
    );

    const geminiData = await geminiRes.json();
    let parsed;
 try {
      const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      console.log('Gemini回傳：', rawText);
      const clean = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      console.log('JSON解析失敗：', e.message);
      parsed = { type: 'chat', reply: '哎呀我沒聽清楚，再說一次？🙏' };
    }

    if (parsed.type === 'accounting') {
      const 品項 = (parsed['品項'] || userMsg).replace(/\d+/g, '').trim();
      const numMatch = userMsg.match(/\d+/);
      const 金額 = numMatch ? Number(numMatch[0]) : (Number(parsed['金額']) || 0);
      const 類別 = detectCategory(userMsg) || parsed['類別'] || '食品';

      await writeToSheet({ 品項, 金額, 類別, sheetName: '流水帳' });

      await client.replyMessage(replyToken, {
        type: 'text',
        text: `${parsed.reply || '記好了！'}\n📝 ${品項}\n💰 NT$${金額}\n🏷️ ${類別}\n\n想補充店名/評價/備註嗎？格式：. 店名 評價 備註`
      });

    } else {
      // 查詢花費
      if (userMsg.includes('今天花') || userMsg.includes('本月花') || userMsg.includes('這個月花') || userMsg.includes('花了多少')) {
        const spendingInfo = await querySpending(userMsg);
        await client.replyMessage(replyToken, {
          type: 'text',
          text: spendingInfo
        });
      } else {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: parsed.reply || '嗯嗯，我在聽 😊'
        });
      }
    }

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

async function updateLastRow({ storeName, rating, note, sheetName }) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[sheetName];
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
  let count = 0;

  for (const row of rows) {
    const date = row['日期'] || '';
    const amount = Number(row['金額']) || 0;
    if (isToday && date === todayStr) {
      total += amount;
      count++;
    } else if (!isToday && date.startsWith(thisMonth)) {
      total += amount;
      count++;
    }
  }

  const period = isToday ? '今天' : '本月';
  return `📊 ${period}共花了 NT$${total}，共 ${count} 筆消費！${total > 3000 ? '\n\n哇花好多，要省一點喔 😅' : '\n\n還不錯，繼續保持 💪'}`;
}
