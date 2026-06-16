#!/bin/bash

echo "=========================================="
echo "   My-ai-app Setup Script (Mac/Linux)"
echo "=========================================="
echo ""

echo "Step 1: Pulling latest code from GitHub..."
git pull origin main
if [ $? -ne 0 ]; then
    echo "ERROR: Git pull failed. Make sure you have git installed."
    exit 1
fi

echo ""
echo "Step 2: Installing dependencies..."
echo "This may take 2-3 minutes..."
npm install
if [ $? -ne 0 ]; then
    echo "ERROR: npm install failed."
    exit 1
fi

echo ""
echo "=========================================="
echo "   ✅ Setup Complete!"
echo "=========================================="
echo ""
echo "Starting your server..."
echo "Open your browser and go to: http://localhost:3000"
echo ""
echo "To test the sync:"
echo "   1. Go to http://localhost:3000/test-sync.html"
echo "   2. Click 'Upload Test Data'"
echo "   3. Click 'Fetch Data'"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

npm run dev
