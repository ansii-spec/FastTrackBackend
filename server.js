const express = require("express");
const fs = require("fs");
const readline = require("readline");
const path = require("path");
const multer = require("multer");
const { exec, spawn } = require("child_process");

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

// In-memory status for async background upload processing
let currentUploadJob = {
  id: null,
  status: "idle", // "idle" | "processing" | "completed" | "error"
  progress: 0,
  stage: "",
  page: 0,
  totalPages: 0,
  studentsLoaded: 0,
  sourceFile: currentSourceFile,
  error: null,
  hint: null,
  details: null,
  startedAt: null,
  completedAt: null
};

// Polling endpoint to check live processing status
app.get("/upload-status", (req, res) => {
  const requestedJobId = req.query.job_id;

  // If a specific new job was requested but hasn't updated the global state yet
  if (requestedJobId && currentUploadJob.id && currentUploadJob.id !== requestedJobId) {
    return res.json({
      id: requestedJobId,
      status: "processing",
      progress: 5,
      stage: "Initializing PDF parser on server...",
      page: 0,
      totalPages: 0,
      studentsLoaded: 0,
      sourceFile: currentSourceFile,
      totalCachedStudents: students.length,
      activeSourceFile: currentSourceFile
    });
  }

  res.json({
    ...currentUploadJob,
    totalCachedStudents: students.length,
    activeSourceFile: currentSourceFile
  });
});

// 1. POST Route to upload PDF: Accepts file, responds immediately (202), and processes in background
app.post("/upload-timetable", upload.single("timetable_pdf"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No PDF file uploaded." });
  }

  // Prevent concurrent upload jobs from colliding
  if (currentUploadJob.status === "processing") {
    fs.unlink(req.file.path, () => {});
    return res.status(409).json({
      error: "A timetable upload is already in progress.",
      hint: "Please wait for the current timetable to finish processing.",
      job_id: currentUploadJob.id
    });
  }

  const uploadedPdfPath = req.file.path;
  const originalPdfName = req.file.originalname;
  const jobId = Date.now().toString();

  console.log(`[Upload] Received PDF: "${originalPdfName}" (${(req.file.size / 1024 / 1024).toFixed(2)} MB). Starting async processing...`);

  // Initialize background job state
  currentUploadJob = {
    id: jobId,
    status: "processing",
    progress: 5,
    stage: "Starting PDF parser in background...",
    page: 0,
    totalPages: 0,
    studentsLoaded: 0,
    sourceFile: originalPdfName,
    error: null,
    hint: null,
    details: null,
    startedAt: new Date().toISOString(),
    completedAt: null
  };

  // RESPOND IMMEDIATELY TO BROWSER - prevents any gateway / browser timeouts!
  res.status(202).json({
    message: "PDF uploaded successfully. Processing started in background.",
    job_id: jobId,
    source_file: originalPdfName,
    status_url: "/upload-status"
  });

  // Launch Python converter asynchronously using spawn to stream real-time progress
  let pythonStderr = "";
  const pyProcess = spawn(pythonCmd, [pythonScriptPath, uploadedPdfPath]);

  pyProcess.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    console.log(`[Python]: ${text.trim()}`);

    // Parse progress from converter.py: "  page 30/68 -> 30 students"
    const match = text.match(/page\s+(\d+)\/(\d+)\s+->\s+(\d+)\s+students/i);
    if (match) {
      const page = parseInt(match[1], 10);
      const totalPages = parseInt(match[2], 10);
      const studentCount = parseInt(match[3], 10);

      currentUploadJob.page = page;
      currentUploadJob.totalPages = totalPages;
      currentUploadJob.studentsLoaded = studentCount;

      // Map progress from 10% to 90% during page parsing
      const pct = Math.round(10 + (page / totalPages) * 80);
      currentUploadJob.progress = Math.min(90, pct);
      currentUploadJob.stage = `Parsed page ${page} of ${totalPages} (${studentCount.toLocaleString()} students found)...`;
    } else if (text.includes("Processing page-by-page")) {
      currentUploadJob.progress = 10;
      currentUploadJob.stage = "Scanning timetable pages...";
    }
  });

  pyProcess.stderr.on("data", (chunk) => {
    pythonStderr += chunk.toString();
  });

  pyProcess.on("error", (err) => {
    console.error(`[Process Launch Error]: ${err.message}`);
    fs.unlink(uploadedPdfPath, () => {});

    currentUploadJob.status = "error";
    currentUploadJob.error = "Failed to launch Python parser.";
    currentUploadJob.details = err.message;
    currentUploadJob.hint = "Verify Python installation and file permissions.";
  });

  pyProcess.on("close", (code, signal) => {
    // Delete temp upload file
    fs.unlink(uploadedPdfPath, (err) => {
      if (err) console.error("Failed to delete temp PDF file:", err);
    });

    if (code !== 0) {
      console.error(`[Python Exit with code ${code} / signal ${signal}]`);
      if (pythonStderr) console.error(`[Python stderr]:\n${pythonStderr}`);

      let errorMessage = "Failed to process the timetable PDF.";
      let solutionHint = "";

      if (pythonStderr && pythonStderr.includes("No module named 'pdfplumber'")) {
        errorMessage = "Python library 'pdfplumber' is missing on the server.";
        solutionHint = "Run 'pip install pdfplumber' in your server environment.";
      } else if (signal === "SIGKILL" || code === 137) {
        errorMessage = "Server ran out of memory (OOM Killed by Linux).";
        solutionHint = "Enable swap memory on your EC2 instance (e.g. 'sudo fallocate -l 2G /swapfile').";
      }

      currentUploadJob.status = "error";
      currentUploadJob.error = errorMessage;
      currentUploadJob.hint = solutionHint;
      currentUploadJob.details = pythonStderr ? pythonStderr.trim() : `Process exited with code ${code}`;
      return;
    }

    console.log(`[Upload] Python finished successfully. Reloading database in memory...`);
    currentUploadJob.stage = "Reloading database cache in memory...";
    currentUploadJob.progress = 95;

    // Reload the database in memory now that the file has been overwritten by Python
    loadDatabase(() => {
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

      currentUploadJob.status = "completed";
      currentUploadJob.progress = 100;
      currentUploadJob.stage = "Timetable processed & synchronized successfully!";
      currentUploadJob.studentsLoaded = students.length;
      currentUploadJob.completedAt = new Date().toISOString();
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
