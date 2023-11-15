// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import type { NextApiRequest, NextApiResponse } from "next";
import { PrismaClient } from "@prisma/client";

import { OpenAI } from "openai";
import { QuizForm } from "..";
import { archive } from "../../common/archive";
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

const prisma = new PrismaClient();

export interface Question {
  question: string;
  answers: string[];
  correctAnswerPositions: number[];
}

export interface QueryQuestionsResponse {
  questions: Question[];
  requestMessage: string;
  responseMessage: string;
}

export interface ResultType {
  questions: Question[];
  requestMessage: string;
  responseMessage: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<QueryQuestionsResponse | any>
) {
  const form: QuizForm = req.body;

  // Save the form to the database
  const savedForm = await prisma.quizForm.create({
    data: {
      ...form,
      language: form.language.name, // or whatever property represents the language as a string
    },
  });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "API not configured" });
    return;
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  console.log("Logging in...");
  // const openai = new OpenAIApi(configuration);

  console.log("Sending message...");
  const message = `I want to make a quiz about ${form.subject}.
I want ${form.amountOfQuestions} questions, with 4 answers per question.
The questions should be in ${form.language.name.split(" - ")[0]}.
Please give me 1 correct answer for each question.
The question can not be longer than 120 characters, and the answers can not be longer than 75 characters.
Format: Question|Answer1|Answer2|Answer3|Answer4
A # mark indicates the correct answer.
Each question and its answers should be on a single line.
Before each question, please write the question number with a $ sign in front.
Example response: 
"$1. What is the capital of France?|Paris#|London|Berlin|Madrid
$2. How many letters are in the english alphabet?|30|24|28|26#"`;
  console.log(message);

  const completion = await client.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: message }],
  });

  // console.log(completion.data);
  const result = completion.choices[0].message.content as string;
  console.log("Got response:");
  console.log(result);

  console.log("Parsing result...");
  const questions: Question[] = [];
  for (const line of result.split("\n")) {
    if (line.startsWith("$") || line.match(/^\d/)) {
      // If line starts with a $ or a number
      const line_split = line.split("|");
      let [first, ...rest] = line_split[0].split(". ");
      const question = rest.join(". ").trim(); // Remove the question number
      const answers = line_split.slice(1).map((x) => x.trim());
      const correctAnswerPositions = answers
        .map((a, i) => (a.includes("#") ? i : -1))
        .filter((i) => i !== -1);

      // Shuffle the answers around and adjust the correct answer positions accordingly
      for (let i = answers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [answers[i], answers[j]] = [answers[j], answers[i]];
        correctAnswerPositions.forEach((p, k) => {
          if (p === i) correctAnswerPositions[k] = j;
          else if (p === j) correctAnswerPositions[k] = i;
        });
      }

      questions.push({
        question,
        answers: answers.map((a) => a.replace("#", "")),
        correctAnswerPositions,
      });
    }
  }
  const r: ResultType = {
    questions: questions,
    requestMessage: message,
    responseMessage: result,
  };
  console.log(r);

  // Save the result to the database
  const savedResult = await prisma.quizResult.create({
    data: {
      questions: JSON.stringify(r.questions),
      requestMessage: r.requestMessage,
      responseMessage: r.responseMessage,
    },
  });

  // Write questions to a text file
  const filePath = path.join(process.cwd(), "questions.txt");
  const questionsText = r.questions
    .map((q, i) => {
      const questionText = `Question ${i + 1}: ${q.question}\n`;
      const answersText = `Options: ${q.answers.join(", ")}\n`;
      const correctAnswersText = `Correct Answers: ${q.correctAnswerPositions
        .map((pos) => q.answers[pos])
        .join(", ")}\n`;
      return questionText + answersText + correctAnswersText;
    })
    .join("\n\n");
  fs.writeFileSync(filePath, questionsText);

  // Create a new PDF document
  const doc = new PDFDocument();
  doc.pipe(fs.createWriteStream("questions.pdf"));

  // Add the questions and answers to the PDF
  r.questions.forEach((q, i) => {
    doc.text(`Question ${i + 1}: ${q.question}`);
    doc.text(`Options: ${q.answers.join(", ")}`);
    doc.text(
      `Correct Answers: ${q.correctAnswerPositions
        .map((pos) => q.answers[pos])
        .join(", ")}`
    );
    doc.moveDown(2); // Add an extra blank line between questions
  });

  // Finalize the PDF and end the stream
  doc.end();

  // Send result to archive api
  await archive(r);

  res.status(200).json(r);
}
