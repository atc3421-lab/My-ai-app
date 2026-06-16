# Setup Instructions

## 🚀 Quick Start

### **If you're on Windows:**
1. Go to your project folder
2. **Double-click** `setup.bat`
3. Wait for the server to start
4. Open browser: **http://localhost:3000/test-sync.html**
5. Click the buttons to test!

### **If you're on Mac/Linux:**
1. Open Terminal
2. Go to your project folder: `cd path/to/My-ai-app`
3. Run: `bash setup.sh`
4. Wait for the server to start
5. Open browser: **http://localhost:3000/test-sync.html**
6. Click the buttons to test!

---

## 📋 What the script does:
- ✅ Pulls latest code from GitHub
- ✅ Installs all dependencies (npm install)
- ✅ Starts the server automatically
- ✅ Opens everything for testing

---

## 🧪 Testing the Sync

Once the server starts:

1. **Open:** http://localhost:3000/test-sync.html
2. **Click:** "📤 Upload Test Data" (simulates mobile uploading)
3. **Click:** "📥 Fetch Data" (simulates desktop retrieving)
4. **Look for:** ✅ SUCCESS messages with your data

---

## 🆘 Troubleshooting

### **Port 3000 already in use?**
The script will tell you. Close other apps using port 3000.

### **Git not found?**
Make sure git is installed: https://git-scm.com/download

### **npm not found?**
Make sure Node.js is installed: https://nodejs.org/

### **Still having issues?**
Share the error message and I'll help fix it! 🔧

---

## 📚 Manual Steps (if script doesn't work)

```bash
# Pull latest code
git pull origin main

# Install dependencies
npm install

# Start server
npm run dev
```

Then go to: **http://localhost:3000/test-sync.html**

---

**That's it! The sync between mobile and desktop is now working!** 🎉
