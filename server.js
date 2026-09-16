const express = require("express");
const fs = require("fs");
const readline = require("readline");
const path = require("path");
const multer = require("multer");
const { exec } = require("child_process");

const app = express();
const PORT = 3000;
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const filePath = path.join(__dirname, "students_timetable.ndjson");
const pythonScriptPath = fs.existsSync(path.join(__dirname, "converter.py"))
  ? path.join(__dirname, "converter.py")
  : path.join(__dirname, "convert.py");

// Detect virtual environment python if available (has pdfplumber installed)
const venvPython = path.join(__dirname, ".env", "bin", "python");
const pythonCmd = fs.existsSync(venvPython) ? `"${venvPython}"` : "python3";

// Configure multer to temporarily store uploaded PDFs in an 'uploads' directory
const upload = multer({ dest: uploadsDir });

// Metadata file to persist the uploaded PDF filename across server restarts
const metadataPath = path.join(__dirname, "timetable_metadata.json");
let currentSourceFile = "Student_Timetables_V#4 Fall-2026.pdf";

if (fs.existsSync(metadataPath)) {
  try {
    const meta = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    if (meta.source_file) {
      currentSourceFile = meta.source_file;
    }
  } catch (err) {
    console.error("Error reading timetable metadata:", err.message);
  }
}

// Array to store parsed student objects in memory
let students = [];

// Helper function to read and parse the NDJSON file line-by-line
function loadDatabase(callback) {
  students = []; // Clear array

  // Check if file exists to prevent server crashing on fresh setups
  if (!fs.existsSync(filePath)) {
    console.log("Database file does not exist yet. Awaiting first upload.");
    if (callback) callback();
    return;
  }

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    const trimmedLine = line.trim();
    if (trimmedLine) {
      try {
        students.push(JSON.parse(trimmedLine));
      } catch (err) {
        console.error("Error parsing line:", trimmedLine, err.message);
      }
    }
  });

  rl.on("close", () => {
    console.log(
      `Database fully loaded. Cached ${students.length} student records.`
    );
    if (callback) callback();
  });
}

// Load the NDJSON records right when the server spins up
loadDatabase();

// 1. POST Route to upload PDF, process it, and update the in-memory cache
app.post("/upload-timetable", upload.single("timetable_pdf"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No PDF file uploaded." });
  }

  const uploadedPdfPath = req.file.path;
  const originalPdfName = req.file.originalname;

  // Execute the Python script, passing the uploaded PDF path as an argument
  exec(`${pythonCmd} "${pythonScriptPath}" "${uploadedPdfPath}"`, (error, stdout, stderr) => {
    // Delete the temporary uploaded PDF file to keep server clean
    fs.unlink(uploadedPdfPath, (err) => {
      if (err) console.error("Failed to delete temp PDF file:", err);
    });

    if (error) {
      console.error(`Python Execution Error: ${error.message}`);
      return res.status(500).json({ error: "Failed to process the timetable PDF." });
    }

    // Reload the database in memory now that the file has been overwritten by Python
    loadDatabase(() => {
      // Store the uploaded PDF's original file name
      currentSourceFile = originalPdfName;
      try {
        fs.writeFileSync(
          metadataPath,
          JSON.stringify({ source_file: currentSourceFile, uploaded_at: new Date().toISOString() }, null, 2)
        );
      } catch (err) {
        console.error("Failed to save timetable metadata:", err.message);
      }

      res.json({
        message: "Timetable updated and reloaded successfully!",
        source_file: currentSourceFile,
        students_loaded: students.length
      });
    });
  });
});

// Serve static assets and root upload page
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 2. GET Route to fetch a student by roll number (Includes filename metadata)
app.get("/:rollno", (req, res) => {
  const rollNo = req.params.rollno.trim().toUpperCase();
  const student = students.find(
    (s) => s.student_id.trim().toUpperCase() === rollNo
  );

  if (!student) {
    return res
      .status(404)
      .json({
        error: `Student with Roll No '${rollNo}' not found.`,
        source_file: currentSourceFile
      });
  }

  // Use spread operator to send the student data along with the uploaded timetable filename
  res.json({
    ...student,
    source_file: currentSourceFile
  });
});

app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
