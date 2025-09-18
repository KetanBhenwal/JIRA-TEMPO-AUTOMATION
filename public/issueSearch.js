// Enhanced search functionality with local caching and hybrid approach
let cachedIssues = [];
let lastCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Load and cache all user's issues for local search
async function loadAndCacheIssues() {
  const now = Date.now();
  
  // Return cached data if it's still fresh
  if (cachedIssues.length > 0 && (now - lastCacheTime) < CACHE_DURATION) {
    console.log('Using cached issues for search');
    return cachedIssues;
  }
  
  try {
    console.log('Loading fresh issue data for caching...');
    
    // Load both assigned issues and mentioned issues
    const [assignedResponse, mentionedResponse] = await Promise.all([
      fetch('/api/issues'),
      fetch('/api/mentioned-issues')
    ]);
    
    if (!assignedResponse.ok || !mentionedResponse.ok) {
      throw new Error('Failed to fetch issues for caching');
    }
    
    const assignedIssues = await assignedResponse.json();
    const mentionedIssues = await mentionedResponse.json();
    
    // Combine and deduplicate issues
    const allIssues = [...assignedIssues, ...mentionedIssues];
    const uniqueIssues = allIssues.filter((issue, index, self) => 
      index === self.findIndex(i => i.key === issue.key)
    );
    
    cachedIssues = uniqueIssues.map(issue => ({
      ...issue,
      source: 'local'
    }));
    
    lastCacheTime = now;
    console.log(`Cached ${cachedIssues.length} issues for local search`);
    
    return cachedIssues;
  } catch (error) {
    console.error('Error caching issues:', error);
    return [];
  }
}

// Enhanced search with local caching + API fallback
async function enhancedIssueSearch(query) {
  if (!query || query.trim().length < 2) {
    return [];
  }
  
  const searchTerm = query.toLowerCase().trim();
  console.log(`Searching for: "${searchTerm}"`);
  
  try {
    // First, search in locally cached issues
    const localIssues = await loadAndCacheIssues();
    const localResults = localIssues.filter(issue => 
      issue.key.toLowerCase().includes(searchTerm) ||
      issue.summary.toLowerCase().includes(searchTerm) ||
      (issue.status && issue.status.toLowerCase().includes(searchTerm))
    );
    
    console.log(`Found ${localResults.length} local results`);
    
    // If we have good local results or the query looks like an issue key, prioritize local
    if (localResults.length > 0 || /^[A-Z]+-\d+/.test(query.toUpperCase())) {
      // Also search API in parallel but don't wait for it initially
      searchAPIInBackground(query, localResults);
      return localResults;
    }
    
    // If no good local results, search API directly
    console.log('No good local results, searching API...');
    return await searchJIRAAPI(query);
    
  } catch (error) {
    console.error('Error in enhanced search:', error);
    // Fallback to API search if local search fails
    try {
      return await searchJIRAAPI(query);
    } catch (apiError) {
      console.error('API search also failed:', apiError);
      return [];
    }
  }
}

// Search JIRA API directly
async function searchJIRAAPI(query) {
  try {
    const response = await fetch(`/api/search-issues?query=${encodeURIComponent(query)}`);
    
    if (!response.ok) {
      throw new Error(`API search failed: ${response.status}`);
    }
    
    const results = await response.json();
    console.log(`API search returned ${results.length} results`);
    
    return results.map(issue => ({
      ...issue,
      source: 'api'
    }));
  } catch (error) {
    console.error('JIRA API search error:', error);
    throw error;
  }
}

// Background API search to supplement local results
async function searchAPIInBackground(query, localResults) {
  try {
    const apiResults = await searchJIRAAPI(query);
    
    // Merge results, prioritizing local but adding unique API results
    const localKeys = new Set(localResults.map(issue => issue.key));
    const uniqueAPIResults = apiResults.filter(issue => !localKeys.has(issue.key));
    
    if (uniqueAPIResults.length > 0) {
      console.log(`Found ${uniqueAPIResults.length} additional results from API`);
      
      // Update the search results display if the user is still viewing the same search
      const currentQuery = document.getElementById('globalSearchBox').value.trim();
      if (currentQuery.toLowerCase() === query.toLowerCase()) {
        const combinedResults = [...localResults, ...uniqueAPIResults];
        renderSearchResults(combinedResults);
      }
    }
  } catch (error) {
    console.error('Background API search failed:', error);
  }
}

// Debounced search function to avoid too many API calls
let searchTimeout;
function debouncedSearch(query, delay = 300) {
  return new Promise((resolve) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
      const results = await enhancedIssueSearch(query);
      resolve(results);
    }, delay);
  });
}

// Smart search with suggestions
async function smartSearch(query) {
  // If it looks like an issue key, search immediately
  if (/^[A-Z]+-\d*$/.test(query.toUpperCase())) {
    return await enhancedIssueSearch(query);
  }
  
  // For other searches, use debouncing
  return await debouncedSearch(query);
}

// Initialize search improvements when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
  console.log('Initializing enhanced search functionality...');
  
  // Pre-load issues for better search performance
  loadAndCacheIssues().then(() => {
    console.log('Initial issue cache loaded');
  }).catch(error => {
    console.warn('Failed to pre-load issue cache:', error);
  });
  
  // Add real-time search to the global search box
  const globalSearchBox = document.getElementById('globalSearchBox');
  if (globalSearchBox) {
    let lastSearchValue = '';
    
    globalSearchBox.addEventListener('input', async function() {
      const query = this.value.trim();
      
      // Only search if the value has changed and is long enough
      if (query === lastSearchValue || query.length < 2) {
        return;
      }
      
      lastSearchValue = query;
      
      // Show loading state
      document.getElementById('loadingSearchResults').classList.remove('hidden');
      document.getElementById('searchResultsContainer').classList.add('hidden');
      
      try {
        const results = await smartSearch(query);
        
        // Only update if this is still the current search
        if (globalSearchBox.value.trim() === query) {
          document.getElementById('loadingSearchResults').classList.add('hidden');
          document.getElementById('searchResultsContainer').classList.remove('hidden');
          renderSearchResults(results);
        }
      } catch (error) {
        console.error('Search error:', error);
        if (globalSearchBox.value.trim() === query) {
          document.getElementById('loadingSearchResults').classList.add('hidden');
          document.getElementById('errorSearchingIssues').classList.remove('hidden');
        }
      }
    });
    
    // Clear search results when input is cleared
    globalSearchBox.addEventListener('input', function() {
      if (this.value.trim().length === 0) {
        document.getElementById('searchResultsContainer').classList.add('hidden');
        document.getElementById('errorSearchingIssues').classList.add('hidden');
        lastSearchValue = '';
      }
    });
  }
  
  // Enhance the existing search button click handler
  const originalPerformGlobalSearch = window.performGlobalSearch;
  window.performGlobalSearch = async function() {
    const searchTerm = document.getElementById('globalSearchBox').value.trim();
    
    if (!searchTerm || searchTerm.length < 2) {
      showError('Please enter at least 2 characters to search');
      return;
    }
    
    document.getElementById('loadingSearchResults').classList.remove('hidden');
    document.getElementById('searchResultsContainer').classList.add('hidden');
    document.getElementById('errorSearchingIssues').classList.add('hidden');
    
    try {
      const results = await enhancedIssueSearch(searchTerm);
      
      document.getElementById('loadingSearchResults').classList.add('hidden');
      document.getElementById('searchResultsContainer').classList.remove('hidden');
      
      renderSearchResults(results);
    } catch (error) {
      console.error('Error searching for issues:', error);
      document.getElementById('loadingSearchResults').classList.add('hidden');
      document.getElementById('errorSearchingIssues').classList.remove('hidden');
    }
  };
});

// Export functions for use in other scripts
if (typeof window !== 'undefined') {
  window.enhancedIssueSearch = enhancedIssueSearch;
  window.loadAndCacheIssues = loadAndCacheIssues;
  window.smartSearch = smartSearch;
}