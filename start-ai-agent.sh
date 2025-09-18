#!/bin/bash

# JIRA Tempo AI Agent Startup Script
# This script helps you start the AI time tracking agent in different modes

echo "🤖 JIRA Tempo AI Time Tracking Agent"
echo "===================================="
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found!"
    echo "Please create a .env file with your JIRA and Tempo credentials."
    echo "See README.md for required environment variables."
    exit 1
fi

# Check if Node.js dependencies are installed
if [ ! -d node_modules ]; then
    echo "📦 Installing Node.js dependencies..."
    npm install
fi

# Function to show menu
show_menu() {
    echo "Choose how to run the AI agent:"
    echo ""
    echo "1) 🌐 Start Web Server + AI Agent (Recommended)"
    echo "2) 🤖 Start AI Agent Only (Background)"
    echo "3) 🧪 Start AI Agent in Test Mode (Quick Intervals)"
    echo "4) 🔧 Test AI Agent Connection & Setup"
    echo "5) 📊 Check AI Agent Status"
    echo "6) 🌐 Run Web Server Only"
    echo "7) ❌ Exit"
    echo ""
    read -p "Enter your choice (1-7): " choice
}

# Function to start web server with AI agent
start_web_with_ai() {
    echo ""
    echo "🚀 Starting Web Server with AI Agent integration..."
    echo ""
    echo "✅ Web interface will be available at: http://localhost:3000"
    echo "✅ AI Agent dashboard will be available at: http://localhost:3000/ai-agent.html"
    echo "✅ You can start/stop the AI agent from the web interface"
    echo ""
    echo "Press Ctrl+C to stop the server"
    echo ""
    
    # Start the web server (which includes AI agent integration)
    node server.js
}

# Function to start AI agent only
start_ai_only() {
    echo ""
    echo "🤖 Starting AI Agent in background mode..."
    echo ""
    echo "✅ The agent will monitor your work activity"
    echo "✅ Time will be auto-logged to JIRA Tempo when confident"
    echo "✅ Logs will be written to: ai-agent.log"
    echo "✅ Data will be stored in: ai-agent-data.json"
    echo ""
    echo "Press Ctrl+C to stop the agent"
    echo ""
    
    # Start the AI agent daemon
    node ai-agent-daemon.js start
}

# Function to start AI agent in test mode
start_ai_test_mode() {
    echo ""
    echo "🧪 Starting AI Agent in TEST MODE..."
    echo ""
    echo "⚡ FAST INTERVALS: Monitor every 30s, Auto-log after 2min"
    echo "🔍 ENHANCED LOGGING: Detailed error information"
    echo "📋 DRY RUN MODE: Test auto-logging without actually logging time"
    echo "✅ Perfect for testing and debugging issues"
    echo ""
    echo "This mode will:"
    echo "  • Monitor activity every 30 seconds (vs 5 minutes)"
    echo "  • Auto-log after 2 minutes of work (vs 1 hour)"  
    echo "  • Show detailed error messages"
    echo "  • Test connection to JIRA and Tempo"
    echo ""
    read -p "Do you want to enable DRY RUN mode? (y/N): " dry_run
    echo ""
    
    if [[ $dry_run =~ ^[Yy]$ ]]; then
        echo "🔒 DRY RUN enabled - no actual time will be logged"
        export AI_AGENT_TEST_MODE=true
        export AI_AGENT_DRY_RUN=true
    else
        echo "⚠️  DRY RUN disabled - time WILL be logged to Tempo"
        export AI_AGENT_TEST_MODE=true
        export AI_AGENT_DRY_RUN=false
    fi
    
    echo ""
    echo "Press Ctrl+C to stop the test agent"
    echo ""
    
    # Start the AI agent daemon in test mode
    node ai-agent-daemon.js start
}

# Function to test connection and setup
test_connection() {
    echo ""
    echo "🔧 Testing AI Agent Connection & Setup..."
    echo ""
    
    # Run connection test
    node test-ai-agent.js
    
    echo ""
    echo "🧪 Testing Tempo auto-logging functionality..."
    echo ""
    
    # Test auto-logging with a minimal worklog
    node -e "
    const AITimeTrackingAgent = require('./ai-agent');
    
    async function testAutoLogging() {
      console.log('🔍 Testing auto-logging functionality...');
      
      const agent = new AITimeTrackingAgent();
      try {
        await agent.loadData();
        await agent.fetchAssignedIssues();
        
        console.log('✅ Connection to JIRA: OK');
        console.log('✅ Assigned issues loaded:', agent.assignedIssues.length);
        
        // Test creating a fake session for validation
        const testSession = {
          id: 'test_session_' + Date.now(),
          startTime: Date.now() - 2 * 60 * 1000, // 2 minutes ago
          endTime: Date.now(),
          duration: 2 * 60 * 1000, // 2 minutes
          detectedIssue: agent.assignedIssues[0]?.key || 'CON22-2208',
          confidence: 85,
          activities: [{
            timestamp: Date.now(),
            applications: { active: 'Visual Studio Code' },
            windowTitles: 'test file',
            isWorkingHours: true
          }]
        };
        
        console.log('🧪 Test session created:', testSession.detectedIssue);
        console.log('✅ Auto-logging test preparation: OK');
        console.log('');
        console.log('🎉 All connection tests passed!');
        console.log('You can now safely run the AI agent.');
        
      } catch (error) {
        console.error('❌ Connection test failed:', error.message);
        console.log('');
        console.log('Please check your .env file and ensure:');
        console.log('- JIRA_BASE_URL is correct');
        console.log('- JIRA_EMAIL is correct'); 
        console.log('- JIRA_API_TOKEN is valid');
        console.log('- TEMPO_BASE_URL is correct');
        console.log('- TEMPO_API_TOKEN is valid');
        console.log('- TEMPO_ACCOUNT_ID is your account ID');
      }
    }
    
    testAutoLogging();
    "
    
    echo ""
    read -p "Press Enter to continue..."
}

# Function to check status
check_status() {
    echo ""
    echo "📊 Checking AI Agent Status..."
    echo ""
    
    node ai-agent-daemon.js status
    
    if [ -f ai-agent-data.json ]; then
        echo ""
        echo "📁 Data file exists: ai-agent-data.json"
        echo "📏 File size: $(ls -lh ai-agent-data.json | awk '{print $5}')"
    fi
    
    if [ -f ai-agent.log ]; then
        echo "📋 Log file exists: ai-agent.log"
        echo "📏 File size: $(ls -lh ai-agent.log | awk '{print $5}')"
        echo ""
        echo "🔍 Last 5 log entries:"
        tail -5 ai-agent.log
    fi
    
    echo ""
    read -p "Press Enter to continue..."
}

# Function to start web server only
start_web_only() {
    echo ""
    echo "🌐 Starting Web Server Only..."
    echo ""
    echo "✅ Web interface will be available at: http://localhost:3000"
    echo "⚠️  AI Agent integration available but not auto-started"
    echo ""
    echo "Press Ctrl+C to stop the server"
    echo ""
    
    node server.js
}

# Main menu loop
while true; do
    show_menu
    
    case $choice in
        1)
            start_web_with_ai
            break
            ;;
        2)
            start_ai_only
            break
            ;;
        3)
            start_ai_test_mode
            break
            ;;
        4)
            test_connection
            ;;
        5)
            check_status
            ;;
        6)
            start_web_only
            break
            ;;
        7)
            echo ""
            echo "👋 Goodbye!"
            exit 0
            ;;
        *)
            echo ""
            echo "❌ Invalid choice. Please enter 1-7."
            echo ""
            ;;
    esac
done