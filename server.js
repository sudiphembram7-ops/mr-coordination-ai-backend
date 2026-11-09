
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import admin from "firebase-admin";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// --------------------------------------------------
// 1. CHECK ENVIRONMENT VARIABLES
// --------------------------------------------------

const requiredEnv = [
  "OPENAI_API_KEY",
  "FIREBASE_DATABASE_URL",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "APP_ORIGIN"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}

// --------------------------------------------------
// 2. FIREBASE ADMIN INITIALIZATION
// --------------------------------------------------

let serviceAccount;

try {
  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );
} catch (error) {
  console.error("Invalid Firebase Service Account JSON.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();

// --------------------------------------------------
// 3. OPENAI INITIALIZATION
// --------------------------------------------------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const OPENAI_MODEL =
  process.env.OPENAI_MODEL || "gpt-6-luna";

// --------------------------------------------------
// 4. CORS AND JSON
// --------------------------------------------------

const allowedOrigins = process.env.APP_ORIGIN
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow server-to-server requests without browser Origin.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Origin not allowed"));
  }
}));

app.use(express.json({ limit: "20kb" }));

// --------------------------------------------------
// 5. RATE LIMIT
// --------------------------------------------------

app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: "Too many requests. Please try again later."
    }
  })
);

// --------------------------------------------------
// 6. HEALTH CHECK
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "MR Coordination AI Backend",
    status: "running"
  });
});

// --------------------------------------------------
// 7. AUTHENTICATION AND ACCESS CONTROL
// --------------------------------------------------

const allowedUIDs = (process.env.ALLOWED_UIDS || "")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

async function verifyFirebaseUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Firebase login token required."
      });
    }

    const idToken = authHeader.slice(7);

    const decodedToken = await admin
      .auth()
      .verifyIdToken(idToken, true);

    if (allowedUIDs.length === 0) {
      return res.status(503).json({
        error: "Backend access is not configured yet."
      });
    }

    if (!allowedUIDs.includes(decodedToken.uid)) {
      return res.status(403).json({
        error: "You are not authorized to use this AI."
      });
    }

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || ""
    };

    next();

  } catch (error) {
    console.error("Authentication error:", error.message);

    return res.status(401).json({
      error: "Invalid or expired Firebase login."
    });
  }
}

// --------------------------------------------------
// 8. READ FIREBASE DATA
// --------------------------------------------------

async function readFirebasePath(path) {
  const snapshot = await db.ref(path).get();
  return snapshot.exists() ? snapshot.val() : {};
}

// --------------------------------------------------
// 9. CONVERT FIREBASE DATA INTO RECORD LISTS
// --------------------------------------------------

function flattenRecords(value, output = []) {
  if (!value) return output;

  if (Array.isArray(value)) {
    for (const item of value) {
      flattenRecords(item, output);
    }
    return output;
  }

  if (typeof value !== "object") {
    return output;
  }

  if (
    value.coachNo !== undefined ||
    value.coachCode !== undefined
  ) {
    output.push(value);

    // Do not lose nested Coach Stock history.
    return output;
  }

  for (const child of Object.values(value)) {
    flattenRecords(child, output);
  }

  return output;
}

// --------------------------------------------------
// 10. SEARCH COACH RECORDS
// --------------------------------------------------

function searchRecords(records, question, limit = 40) {
  const text = String(question || "").toLowerCase();

  // First try exact Coach Number search.
  const numbers = text.match(/\b\d+\b/g) || [];

  if (numbers.length > 0) {
    const exactMatches = records.filter(record => {
      const coachNo = String(record.coachNo || "").trim();
      const coachCode = String(record.coachCode || "").trim();

      return numbers.some(number =>
        coachNo === number || coachCode === number
      );
    });

    return exactMatches.slice(0, limit);
  }

  // Otherwise search by words.
  const stopWords = new Set([
    "the", "is", "are", "was", "were", "where",
    "what", "when", "which", "who", "show", "find",
    "tell", "please", "coach", "number", "about",
    "this", "that", "from", "with", "have", "has",
    "কোচ", "কোথায়", "কোথায়", "কোন", "কি", "কী",
    "দেখান", "বলুন", "আমাকে", "এর", "এবং"
  ]);

  const words = text
    .split(/[\s,.:;!?()[\]{}]+/)
    .map(word => word.trim())
    .filter(word => word.length >= 2 && !stopWords.has(word));

  if (words.length === 0) {
    return [];
  }

  const matches = records
    .map(record => {
      const recordText = JSON.stringify(record).toLowerCase();

      const score = words.reduce(
        (total, word) =>
          total + (recordText.includes(word) ? 1 : 0),
        0
      );

      return { record, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return matches
    .slice(0, limit)
    .map(item => item.record);
}

// --------------------------------------------------
// 11. AI INSTRUCTIONS
// --------------------------------------------------

const AI_INSTRUCTIONS = `
You are MR CO-ORDINATION DAILY COACHES POSITION AI ASSISTANT.

You help authorized railway coach coordination staff.

RULES:

1. Answer in Bengali when the user writes Bengali.
2. Answer in English when the user writes English.
3. Use only the Firebase records supplied in the context.
4. Never invent Coach Numbers, Shop names, Positions, Dates or Status.
5. Clearly distinguish Daily Position from Coach Stock.
6. If a record is not found, say it was not found in the supplied records.
7. If records conflict, explain the conflict instead of guessing.
8. For Coach Number questions, identify the exact matching Coach Number.
9. Use history records when available.
10. This assistant is READ-ONLY. Never claim that you saved,
    updated, moved, swapped or deleted a coach.
11. Keep answers clear, practical and concise.
12. Do not reveal Firebase credentials, API keys or private
    authentication information.
`;

// --------------------------------------------------
// 12. MAIN AI ENDPOINT
// --------------------------------------------------

app.post(
  "/api/coach-ai",
  verifyFirebaseUser,
  async (req, res) => {
    try {
      const question = String(req.body?.message || "").trim();

      if (!question) {
        return res.status(400).json({
          error: "Please enter a question."
        });
      }

      if (question.length > 1500) {
        return res.status(400).json({
          error: "Question is too long. Maximum 1500 characters."
        });
      }

      // Read the four required Firebase locations.
      const [
        boardData,
        pulledOutData,
        stockData,
        historyData
      ] = await Promise.all([
        readFirebasePath("coachBoard"),
        readFirebasePath("pulledOut"),
        readFirebasePath("coachStock/records"),
        readFirebasePath("history")
      ]);

      const boardRecords = flattenRecords(boardData);
      const pulledOutRecords = flattenRecords(pulledOutData);
      const stockRecords = flattenRecords(stockData);
      const historyRecords = flattenRecords(historyData);

      // Search each data source separately.
      const context = {
        dailyPosition: searchRecords(boardRecords, question),
        pulledOut: searchRecords(pulledOutRecords, question),
        coachStock: searchRecords(stockRecords, question),
        dailyPositionHistory: searchRecords(historyRecords, question)
      };

      const totalMatches =
        context.dailyPosition.length +
        context.pulledOut.length +
        context.coachStock.length +
        context.dailyPositionHistory.length;

      if (totalMatches === 0) {
        return res.json({
          success: true,
          answer:
            "এই প্রশ্নের সঙ্গে মেলে এমন কোনো রেকর্ড পাওয়া যায়নি। Coach Number বা Shop-এর নাম দিয়ে আবার চেষ্টা করুন।",
          sources: []
        });
      }

      // Limit context size before sending it to the AI.
      const contextText = JSON.stringify(context).slice(0, 45000);

      const response = await openai.responses.create({
        model: OPENAI_MODEL,
        instructions: AI_INSTRUCTIONS,
        input: [
          {
            role: "user",
            content:
              "STAFF QUESTION:\n" +
              question +
              "\n\nFIREBASE RECORDS:\n" +
              contextText
          }
        ],
        max_output_tokens: 1200,
        store: false
      });

      return res.json({
        success: true,
        answer: response.output_text ||
          "দুঃখিত, AI উত্তর তৈরি করতে পারেনি।",
        sources: [
          "Daily Position",
          "Pulled Out",
          "Coach Stock",
          "Daily Position History"
        ]
      });

    } catch (error) {
      console.error("Coach AI Error:", error);

      return res.status(500).json({
        error: "AI service error. Please try again."
      });
    }
  }
);

// --------------------------------------------------
// 13. ERROR HANDLER
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error("Server error:", error.message);

  res.status(500).json({
    error: "Server error."
  });
});

// --------------------------------------------------
// 14. START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `MR Coordination AI Backend running on port ${PORT}`
  );
});
