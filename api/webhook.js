const line = require('@line/bot-sdk');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(lineConfig);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'ok' });
  }

  const events = req.body.events;
  if (!events || events.length === 0) {
    return res.status(200).json({ status: 'ok' });
  }

  const event = events[0];
  if (event.type !== 'message' || !event.message.text) {
    return res.status(200).json({ status: 'ok' });
  }

  const userMsg = event.message.text;
  const replyToken = event.replyToken;

  try {
    // 呼叫 Gemini 分類
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `你是記帳助理，請從這句話中擷取記帳資訊，並判斷類別。
只能回傳 JSON 格式，不要其他文字：
{"品項":"xxx","金額":000,"類別":"xxx","類型":"生活或創業"}

類別選項：食品、交通、住居、娛樂、醫療、創業耗材、創業設備、創業其他、其他
類型判斷：提到3D列印、耗材、設備、PLA、拓竹、樹脂、創業相關的選「創業」，其他選「生活」

這句話：${userMsg}`
            }]
          }]
        })
      }
    );

    const geminiData = await geminiRes.json();
    const geminiText = geminiData.candidates[0].content.parts[0].text;
    const clean = geminiText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    const 品項 = parsed['品項'] || userMsg;
    const 金額 = parsed['金額'] || 0;
    const 類別 = parsed['類別'] || '其他';
    const 類型 = parsed['類型'] || '生活';

    // 記到試算表
    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
    await doc.loadInfo();

    const sheet = 類型 === '創業' ? doc.sheetsByIndex[1] : doc.sheetsByIndex[0];
    const today = new Date().toLocaleDateString('zh-TW');
    await sheet.addRow([today, 品項, 金額, 類別, 類型]);

    // 回覆 LINE
    await client.replyMessage(replyToken, {
      type: 'text',
      text: `✅ 已記帳！\n📝 ${品項}\n💰 NT$${金額}\n🏷️ ${類別}（${類型}）`
    });

    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    console.error(err);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '記帳失敗，請重試或換個說法'
    });
    return res.status(200).json({ status: 'error' });
  }
};
