// Pagination utilities for JIRA Tempo Time Logger
// This script handles client-side pagination for all tables

const itemsPerPage = 10;

// Paginate issues table
function paginateIssues(issues, page) {
    const startIndex = (page - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, issues.length);
    return issues.slice(startIndex, endIndex);
}

// Update pagination controls
function updatePagination(currentPage, totalItems, paginationContainer, onPageChange) {
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    
    if (totalPages <= 1) {
        paginationContainer.classList.add('hidden');
        return;
    }
    
    paginationContainer.classList.remove('hidden');
    paginationContainer.innerHTML = '';
    
    // Previous page button
    const prevButton = document.createElement('button');
    prevButton.className = 'pagination-button';
    prevButton.textContent = '← Previous';
    prevButton.disabled = currentPage === 1;
    prevButton.addEventListener('click', () => onPageChange(currentPage - 1));
    paginationContainer.appendChild(prevButton);
    
    // Page info
    const pageInfo = document.createElement('span');
    pageInfo.className = 'pagination-info';
    pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
    paginationContainer.appendChild(pageInfo);
    
    // Next page button
    const nextButton = document.createElement('button');
    nextButton.className = 'pagination-button';
    nextButton.textContent = 'Next →';
    nextButton.disabled = currentPage === totalPages;
    nextButton.addEventListener('click', () => onPageChange(currentPage + 1));
    paginationContainer.appendChild(nextButton);
}

// Helper function to enhance the rendering functions with pagination
function enhanceRenderFunctions() {
    // Store original render functions
    const originalRenderIssues = window.renderIssues;
    const originalRenderMentionedIssues = window.renderMentionedIssues;
    const originalRenderSearchResults = window.renderSearchResults;
    
    // Variables to track current page for each table
    let currentIssuePage = 1;
    let currentMentionedPage = 1;
    let currentSearchPage = 1;
    
    // Override renderIssues function
    if (typeof originalRenderIssues === 'function') {
        window.renderIssues = function(issues) {
            const paginatedIssues = paginateIssues(issues, currentIssuePage);
            originalRenderIssues(paginatedIssues);
            
            updatePagination(
                currentIssuePage, 
                issues.length, 
                document.getElementById('issuesPagination'),
                (page) => {
                    currentIssuePage = page;
                    window.renderIssues(issues);
                }
            );
        };
    }
    
    // Override renderMentionedIssues function
    if (typeof originalRenderMentionedIssues === 'function') {
        window.renderMentionedIssues = function(issues) {
            const paginatedIssues = paginateIssues(issues, currentMentionedPage);
            originalRenderMentionedIssues(paginatedIssues);
            
            updatePagination(
                currentMentionedPage, 
                issues.length, 
                document.getElementById('mentionedPagination'),
                (page) => {
                    currentMentionedPage = page;
                    window.renderMentionedIssues(issues);
                }
            );
        };
    }
    
    // Override renderSearchResults function
    if (typeof originalRenderSearchResults === 'function') {
        window.renderSearchResults = function(issues) {
            const paginatedIssues = paginateIssues(issues, currentSearchPage);
            originalRenderSearchResults(paginatedIssues);
            
            updatePagination(
                currentSearchPage, 
                issues.length, 
                document.getElementById('searchPagination'),
                (page) => {
                    currentSearchPage = page;
                    window.renderSearchResults(issues);
                }
            );
        };
    }
}

// Initialize pagination when the DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    // Enhance render functions with pagination after a short delay
    // to ensure original functions are defined
    setTimeout(enhanceRenderFunctions, 100);
});
