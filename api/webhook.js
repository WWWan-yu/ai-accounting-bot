const line = require('@line/bot-sdk');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const userSessions = {};

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
  const userId = event.source.userId;

  try {
    const session = userSessions[userId];

    // 如果有待確認的記帳資料
    if (session && session.step === 'ask_details') {
      const parts = userMsg.split(/[,，\s]+/);
      session.storeName = parts[0] || '';
      session.rating = parts[1] || '';
      session.note = parts[2] || '';

      // 寫進試算表
      await writeToSheet(session);

      delete userSessions[userId];

      await client.replyMessage(replyToken, {
        type: 'text',
        text: `✅ 記帳完成！\n📝 ${session.品項}\n💰 NT$${session.金額}\n🏷️ ${session.類別}\n🏪 ${session.storeName || '未填'}\n⭐ ${session.rating || '未填'}\n📌 ${session.note || '未填'}`
      });

      return res.status(200).json({ status: 'ok' });
    }

    // 第一句話，呼叫 Gemini 解析
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `你是記帳助理，從這句話擷取記帳資訊，只回傳JSON不要其他文字：
{"品項":"xxx","金額":數字,"類別":"xxx"}
類別選項：食品、交通、住居、娛樂、醫療、購物、創業耗材、創業設備、創業其他、其他
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
      const clean = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      parsed = { 品項: userMsg, 金額: 0, 類別: '其他' };
    }

    const 品項 = parsed['品項'] || userMsg;
    const 金額 = parsed['金額'] || 0;
    const 類別 = parsed['類別'] || '其他';

    // 暫存 session，等待追問
    userSessions[userId] = { 品項, 金額, 類別, step: 'ask_details' };

    await client.replyMessage(replyToken, {
      type: 'text',
      text: `收到！\n📝 ${品項}　💰 NT$${金額}　🏷️ ${類別}\n\n店名、評價、備註呢？（用逗號分隔，例如：火鍋店,好吃,下次再來）\n不想填直接回「ok」`
    });

    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    console.error(err);
    delete userSessions[userId];
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '記帳失敗，請重試'
    });
    return res.status(200).json({ status: 'error' });
  }
};

async function writeToSheet(data) {
  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['流水帳'];
  const today = new Date().toLocaleDateString('zh-TW');
  await sheet.addRow({
    日期: today,
    品項: data.品項,
    金額: data.金額,
    類別: data.類別,
    店名: data.storeName || '',
    評價: data.rating || '',
    備註: data.note || '',
  });
}
