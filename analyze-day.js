exports.handler = async function (event) {
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        }
      };
    }
  
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
  
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    };
  
    try {
      const payload = JSON.parse(event.body || '{}');
      const text = String(payload.text || '').trim();
      const track = payload.track || {};
      const photoStats = payload.photoStats || { avgWarmth: 0.5, avgLuminance: 0.5 };
  
      if (!text) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Text is required' }) };
      }
  
      const geminiKey = process.env.GEMINI_API_KEY;
      const openaiKey = process.env.OPENAI_API_KEY;
  
      if (geminiKey) {
        const llmResult = await callGemini(geminiKey, text, track, photoStats);
        if (llmResult) {
          return { statusCode: 200, headers, body: JSON.stringify({ ...llmResult, source: 'gemini' }) };
        }
      }
  
      if (openaiKey) {
        const llmResult = await callOpenAI(openaiKey, text, track, photoStats);
        if (llmResult) {
          return { statusCode: 200, headers, body: JSON.stringify({ ...llmResult, source: 'openai' }) };
        }
      }
  
      const fallback = deterministicAnalyze(text, track, photoStats);
      return { statusCode: 200, headers, body: JSON.stringify({ ...fallback, source: 'semantic-rules' }) };
    } catch (err) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err.message || 'Internal Server Error' })
      };
    }
  };
  
  function buildPrompt(text, track, photoStats) {
    return `Ты — движок анализа атмосферы личного дневника «Проявка».
  Преврати описание дня, метаданные песни и световые метрики фото в художественные оси для генеративного 4:5 холста.
  Не ставь оценок человеку и не ставь психологических диагнозов — описывай только свет, ритм, пространство и плотность сцены.
  
  Ввод:
  - Текст дня: "${text}"
  - Песня: "${track.title || ''}" — ${track.artist || ''}, жанр: ${track.genre || ''}, год релиза: ${track.releaseYear || 'неизвестен'}
  - Световые метрики фото: теплота=${photoStats.avgWarmth}, яркость=${photoStats.avgLuminance}
  
  Верни СТРОГО валидный JSON без markdown:
  {
    "folder_name": "Короткое поэтичное название папки от 3 до 7 слов по смыслу дня",
    "energy": число от 0.1 до 1.0 (темп и динамика дня и музыки),
    "warmth": число от 0.0 до 1.0 (цветовая температура света),
    "crowd_density": число от 0.0 до 1.0 (0 = уединение и много воздуха Ма, 1 = плотный многослойный коллаж Матисса с людьми/событиями),
    "era_grain": число от 0.0 до 0.85 (зернистость плёнки: для треков после 2018 года близко к 0.05, для старых/ностальгических 0.45-0.8),
    "light_angle": "high_noon" | "dusk" | "night_lamp",
    "estimated_bpm": целое число от 60 до 165,
    "voice_rate": число от 0.85 до 1.22 (темп озвучки),
    "voice_pitch": число от 0.9 до 1.12,
    "explanation": "1-2 конкретных предложения на русском языке: как текст, пиксели фото и музыка определили этот визуал"
  }`;
  }
  
  async function callGemini(apiKey, text, track, photoStats) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(text, track, photoStats) }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.4 }
        })
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return raw ? sanitizeAxes(JSON.parse(raw)) : null;
  }
  
  async function callOpenAI(apiKey, text, track, photoStats) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: buildPrompt(text, track, photoStats) }],
        temperature: 0.4
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    return raw ? sanitizeAxes(JSON.parse(raw)) : null;
  }
  
  function clamp(val, min, max, fallback) {
    const n = Number(val);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }
  
  function sanitizeAxes(obj) {
    const validAngles = ['high_noon', 'dusk', 'night_lamp'];
    const words = String(obj.folder_name || 'Снимок одного дня').trim().split(/\s+/);
    const folderName = words.slice(0, 7).join(' ');
    return {
      folder_name: folderName,
      energy: clamp(obj.energy, 0.1, 1.0, 0.55),
      warmth: clamp(obj.warmth, 0.0, 1.0, 0.55),
      crowd_density: clamp(obj.crowd_density, 0.0, 1.0, 0.5),
      era_grain: clamp(obj.era_grain, 0.0, 0.85, 0.2),
      light_angle: validAngles.includes(obj.light_angle) ? obj.light_angle : 'dusk',
      estimated_bpm: Math.round(clamp(obj.estimated_bpm, 60, 165, 100)),
      voice_rate: clamp(obj.voice_rate, 0.85, 1.22, 1.0),
      voice_pitch: clamp(obj.voice_pitch, 0.9, 1.12, 1.0),
      explanation: String(obj.explanation || 'Композиция построена по ритму трека, палитре кадров и тону записи.')
    };
  }
  
  // Семантический разбор по целым токенам (исключает ложные срабатывания вроде «гор» в «город»)
  function deterministicAnalyze(text, track, photoStats) {
    const tokens = text
      .toLowerCase()
      .replace(/[^а-яёa-z0-9\s-]/gi, ' ')
      .split(/\s+/)
      .filter(Boolean);
  
    const hasWord = (prefixes) =>
      tokens.some((tok) => prefixes.some((p) => (p.endsWith('*') ? tok.startsWith(p.slice(0, -1)) : tok === p)));
  
    const isMountainHike = hasWord(['пик*', 'гор*', 'подъем*', 'подъём*', 'троп*', 'вершин*', 'фурманов*', 'поход*']) && !hasWord(['город*']);
    const isFriendsGroup = hasWord(['друз*', 'одноклассник*', 'ребят*', 'вместе', 'компани*', 'смея*', 'крича*', 'танц*']);
    const isSummerSun = hasWord(['лет*', 'солнц*', 'жар*', 'ярк*', 'полдень', 'небо', 'дневн*']);
    const isNightCalm = hasWord(['ноч*', 'тишин*', 'тих*', 'дожд*', 'один*', 'трамва*', 'пуст*', 'окн*', 'сумерк*', 'ламп*']);
  
    const genre = String(track.genre || '').toLowerCase();
    const titleArtist = `${track.title || ''} ${track.artist || ''}`.toLowerCase();
    const year = Number(track.releaseYear) || 2020;
  
    let estimatedBpm = 96;
    if (/friday|riton|nightcrawlers/.test(titleArtist)) estimatedBpm = 123;
    else if (/dance|electronic|house|pop|hip-hop/.test(genre)) estimatedBpm = 120;
    else if (/jazz|ambient|classical|piano/.test(genre)) estimatedBpm = 72;
  
    let energy = clamp((estimatedBpm - 60) / 80, 0.15, 0.98, 0.55);
    if (isMountainHike || isFriendsGroup) energy = Math.max(energy, 0.85);
    if (isNightCalm) energy = Math.min(energy, 0.34);
  
    let warmth = clamp(photoStats.avgWarmth, 0.1, 0.95, 0.55);
    if (isSummerSun) warmth = Math.max(warmth, 0.82);
    if (isNightCalm && !hasWord(['ламп*', 'шоколад*', 'чай*'])) warmth = Math.min(warmth, 0.38);
  
    let crowdDensity = 0.45;
    if (isFriendsGroup || isMountainHike) crowdDensity = 0.88;
    else if (isNightCalm) crowdDensity = 0.18;
  
    // Эпоха трека управляет зерном: новые релизы (2019+) дают чистую цифровую картинку без зерна
    let eraGrain = year >= 2019 ? 0.04 : year >= 2005 ? 0.24 : 0.58;
    if (isNightCalm && year < 2019) eraGrain = Math.max(eraGrain, 0.45);
  
    let lightAngle = 'dusk';
    if (isSummerSun || isMountainHike) lightAngle = 'high_noon';
    else if (isNightCalm) lightAngle = 'night_lamp';
  
    // Генерация смыслового названия папки (3-7 слов)
    let folderName = 'Запись прожитого дня';
    if (isMountainHike && hasWord(['фурманов*'])) {
      folderName = 'Летний подъём на пик Фурманова';
    } else if (isMountainHike) {
      folderName = 'Солнечный подъём в горы с друзьями';
    } else if (isNightCalm && hasWord(['дожд*', 'трамва*'])) {
      folderName = 'Тихий ночной дождь за стеклом';
    } else if (isFriendsGroup) {
      folderName = 'Шумный день в кругу друзей';
    } else {
      const meaningful = tokens.filter((w) => w.length > 3).slice(0, 4);
      if (meaningful.length >= 2) {
        const joined = meaningful.join(' ');
        folderName = joined.charAt(0).toUpperCase() + joined.slice(1);
      }
    }
  
    const voiceRate = Number((0.88 + energy * 0.28).toFixed(2));
    const voicePitch = Number((0.94 + warmth * 0.12).toFixed(2));
  
    const explanation =
      `Трек (${estimatedBpm} BPM, ${year} г.) задал ритм штрихов и минимальное зерно (${Math.round(eraGrain * 100)}%). ` +
      `${crowdDensity > 0.65 ? 'Высокая плотность событий и людей собрала кадры в многослойный декупаж в духе Матисса.' : 'Уединённый тон записи оставил больше свободного воздуха в духе Ма.'} ` +
      `Свет направлен ${lightAngle === 'high_noon' ? 'сверху как в летний полдень' : lightAngle === 'night_lamp' ? 'камерным ночным пятном' : 'мягким вечерним градиентом'}.`;
  
    return sanitizeAxes({
      folder_name: folderName,
      energy,
      warmth,
      crowd_density: crowdDensity,
      era_grain: eraGrain,
      light_angle: lightAngle,
      estimated_bpm: estimatedBpm,
      voice_rate: voiceRate,
      voice_pitch: voicePitch,
      explanation
    });
  }