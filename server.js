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

// Detect Python executable across virtual environments or system path
function getPythonCommand() {
  if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) {
    return process.env.PYTHON_PATH;
  }
  const candidatePaths = [
    path.join(__dirname, "venv", "bin", "python"),
    path.join(__dirname, ".env", "bin", "python"),
    path.join(__dirname, "env", "bin", "python"),
    path.join(process.env.HOME || "", "venv", "bin", "python"),
    path.join(process.env.HOME || "", ".venv", "bin", "python"),
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) return p;
  }
  return "python3";
}

const pythonCmd = getPythonCommand();

// Startup check for pdfplumber dependency
exec(`"${pythonCmd}" -c "import pdfplumber"`, (err) => {
  if (err) {
    console.warn(`\n⚠️  WARNING: 'pdfplumber' is NOT found in Python environment (${pythonCmd}).`);
    console.warn("   To fix, run in your terminal: pip install pdfplumber\n");
  } else {
    console.log(`Python interpreter verified with 'pdfplumber': ${pythonCmd}`);
  }
});

// Configure multer to temporarily store uploaded PDFs with a 100MB limit
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 100 * 1024 * 1024 }
});

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
  // Allow up to 10 minutes for large timetable PDF extraction
  req.setTimeout(600000);
  res.setTimeout(600000);

  if (!req.file) {
    return res.status(400).json({ error: "No PDF file uploaded." });
  }

  const uploadedPdfPath = req.file.path;
  const originalPdfName = req.file.originalname;

  console.log(`[Upload] Processing timetable PDF: "${originalPdfName}" (${(req.file.size / 1024 / 1024).toFixed(2)} MB)...`);

  // Execute the Python script with expanded buffer and timeout
  const execOptions = {
    maxBuffer: 30 * 1024 * 1024, // 30MB stdout buffer to prevent overflow on large PDFs
    timeout: 600000              // 10 minute timeout
  };

  exec(`"${pythonCmd}" "${pythonScriptPath}" "${uploadedPdfPath}"`, execOptions, (error, stdout, stderr) => {
    // Delete the temporary uploaded PDF file to keep server clean
    fs.unlink(uploadedPdfPath, (err) => {
      if (err) console.error("Failed to delete temp PDF file:", err);
    });

    if (error) {
      console.error(`[Upload Error]: ${error.message}`);
      if (stderr) console.error(`[Python stderr]:\n${stderr}`);

      let errorMessage = "Failed to process the timetable PDF.";
      let solutionHint = "";

      if (stderr && stderr.includes("No module named 'pdfplumber'")) {
        errorMessage = "Python library 'pdfplumber' is missing on the server.";
        solutionHint = "Run 'pip install pdfplumber' in your server environment.";
      } else if (error.signal === "SIGKILL" || error.code === 137) {
        errorMessage = "Server ran out of memory (OOM Killed by Linux).";
        solutionHint = "Enable swap memory on your EC2 instance (e.g. 'sudo fallocate -l 2G /swapfile').";
      }

      return res.status(500).json({
        error: errorMessage,
        hint: solutionHint,
        details: stderr ? stderr.trim() : error.message
      });
    }

    console.log(`[Upload] PDF parsed successfully by Python.`);

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

      console.log(`[Upload] Database reloaded with ${students.length} student records.`);

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

const server = app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);

// Keep TCP sockets alive for lengthy file processing
server.setTimeout(600000);
server.keepAliveTimeout = 65000;
