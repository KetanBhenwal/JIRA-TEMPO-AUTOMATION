// Work attributes handling
let workAttributes = {};

// Immediately create the work attributes section on page load
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded - initializing work attributes');
    
    // Add a style for the spinner if not already added
    if (!document.getElementById('workAttributesSpinner')) {
        const style = document.createElement('style');
        style.id = 'workAttributesSpinner';
        style.textContent = `
            @keyframes spin {
                to { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }
    
    // Initialize with a small delay to ensure the DOM is fully loaded
    setTimeout(() => {
        // Find the work attributes container
        let container = document.getElementById('workAttributesContainer');
        if (!container) {
            console.warn('Work attributes container not found, will try to create it');
            
            // Try to find a suitable location for the container
            const logTimeContainer = document.getElementById('logTimeContainer');
            const columnDiv = logTimeContainer ? logTimeContainer.querySelector('.column:nth-child(2)') : null;
            
            if (columnDiv) {
                console.log('Found column to place work attributes in');
                container = document.createElement('div');
                container.id = 'workAttributesContainer';
                columnDiv.appendChild(container);
            } else {
                console.error('Could not find appropriate location for work attributes container');
                return; // Exit if we can't find a place to put the container
            }
        }
        
        // Show loading state
        container.innerHTML = `
            <h3>Work Attributes</h3>
            <div style="text-align: center; margin: 20px 0;">
                <div style="display: inline-block; width: 20px; height: 20px; border: 3px solid #ccc; border-radius: 50%; border-top-color: #0052cc; animation: spin 1s linear infinite;"></div>
                <p>Loading work attributes...</p>
            </div>
        `;
        
        // Fetch the work attributes
        fetchWorkAttributes();
    }, 300);
});

// Fetch work attributes from Tempo API - focus on Time Type and Tech Time Type
async function fetchWorkAttributes() {
    try {
        console.log('Fetching work attributes from API...');
        
        // Find the work attributes container
        const container = document.getElementById('workAttributesContainer');
        if (!container) {
            console.error('workAttributesContainer element not found!');
            // Try to recreate it
            const logTimeContainer = document.getElementById('logTimeContainer');
            if (logTimeContainer) {
                const columnDiv = logTimeContainer.querySelector('.column:nth-child(2)');
                if (columnDiv) {
                    console.log('Recreating work attributes container');
                    const newContainer = document.createElement('div');
                    newContainer.id = 'workAttributesContainer';
                    newContainer.innerHTML = '<h3>Work Attributes</h3><p>Loading...</p>';
                    columnDiv.appendChild(newContainer);
                    // Continue execution with the new container
                } else {
                    throw new Error('Could not find column to place work attributes container');
                }
            } else {
                throw new Error('Log time container not found');
            }
        }
        
        const response = await fetch('/api/tempo/work-attributes');
        
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('Work attributes received:', data);
        workAttributes = data;
        
        // Get a reference to the container again in case DOM has changed
        const updatedContainer = document.getElementById('workAttributesContainer');
        if (!updatedContainer) {
            throw new Error('Work attributes container disappeared during fetch');
        }
        
        updatedContainer.innerHTML = '<h3>Work Attributes</h3>';
        
        // Check if we have any attributes
        if (Object.keys(workAttributes).length === 0) {
            updatedContainer.innerHTML += '<p>No work attributes available. Please check server configuration.</p>';
            console.warn('No work attributes found in the API response');
            return;
        }
        
        // Create Time Type dropdown
        if (workAttributes['_TimeCategory_']) {
            createAttributeDropdown(updatedContainer, '_TimeCategory_', 'Time Type', true);
        } else {
            console.warn('Time Type attribute (_TimeCategory_) not found!');
            updatedContainer.innerHTML += '<div style="color: #ae2a19; margin-bottom: 10px;">Time Type attribute not available</div>';
        }
        
        // Create Technology Time Type dropdown
        if (workAttributes['_TechnologyTimeType_']) {
            createAttributeDropdown(updatedContainer, '_TechnologyTimeType_', 'Technology Time Type', false);
        } else {
            console.warn('Technology Time Type attribute (_TechnologyTimeType_) not found!');
            updatedContainer.innerHTML += '<div style="color: #ae2a19; margin-bottom: 10px;">Technology Time Type attribute not available</div>';
        }
        
        console.log('Work attributes dropdowns created successfully');
        
    } catch (error) {
        console.error('Error fetching work attributes:', error);
        const container = document.getElementById('workAttributesContainer');
        if (container) {
            container.innerHTML = `
                <h3>Work Attributes</h3>
                <div style="color: #ae2a19; background-color: #ffebe6; border-left: 4px solid #ff5630; padding: 15px; margin: 15px 0; border-radius: 3px;">
                    Failed to load work attributes: ${error.message}
                </div>
                <button onclick="fetchWorkAttributes()" class="button" style="background-color: #0052cc; color: white; border: none; padding: 8px 12px; border-radius: 3px; cursor: pointer;">Try Again</button>
            `;
        } else {
            console.error('Could not update container with error message');
        }
    }
}

// Helper function to create a dropdown for an attribute
function createAttributeDropdown(container, attributeKey, labelText, isRequired) {
    console.log(`Creating dropdown for ${attributeKey}`);
    
    if (!container) {
        console.error('Container element is null or undefined');
        return;
    }
    
    const attr = workAttributes[attributeKey];
    if (!attr) {
        console.warn(`Attribute ${attributeKey} not found in workAttributes`);
        // Add a visible error message
        const errorDiv = document.createElement('div');
        errorDiv.style.color = '#ae2a19';
        errorDiv.style.marginBottom = '10px';
        errorDiv.textContent = `Attribute ${attributeKey} not available`;
        container.appendChild(errorDiv);
        return;
    }
    
    if (!attr.values || attr.values.length === 0) {
        console.warn(`No values found for attribute ${attributeKey}`);
        // Add a visible warning
        const warningDiv = document.createElement('div');
        warningDiv.style.color = '#ff8b00';
        warningDiv.style.marginBottom = '10px';
        warningDiv.textContent = `No values available for ${labelText || attr.name}`;
        container.appendChild(warningDiv);
        return;
    }
    
    // Create attribute selector
    const selectGroup = document.createElement('div');
    selectGroup.style.marginBottom = '15px';
    
    const label = document.createElement('label');
    label.htmlFor = `attr-${attributeKey}`;
    label.textContent = labelText || attr.name;
    label.style.fontWeight = '500';
    label.style.display = 'block';
    label.style.marginTop = '10px';
    
    if (isRequired) {
        const requiredSpan = document.createElement('span');
        requiredSpan.style.color = '#ff5630';
        requiredSpan.textContent = ' *';
        label.appendChild(requiredSpan);
    }
    
    const select = document.createElement('select');
    select.id = `attr-${attributeKey}`;
    select.className = 'attribute-select';
    select.style.width = '100%';
    select.style.padding = '10px';
    select.style.margin = '8px 0';
    select.style.border = '1px solid #dfe1e6';
    select.style.borderRadius = '3px';
    select.style.boxSizing = 'border-box';
    select.dataset.key = attributeKey;
    if (isRequired) {
        select.required = true;
    }
    
    // Add default option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = `-- Select ${labelText || attr.name} --`;
    select.appendChild(defaultOption);
    
    // Add options for values
    console.log(`Adding ${attr.values.length} options for ${attributeKey}`);
    attr.values.forEach(value => {
        const option = document.createElement('option');
        
        // Handle different value formats
        if (typeof value === 'string') {
            // If value is just a string
            option.value = value;
            option.textContent = value;
        } else if (typeof value === 'object' && value !== null) {
            // If value is an object with properties
            option.value = value.value || value.name || value;
            option.textContent = value.name || value.value || value;
        }
        
        select.appendChild(option);
    });
    
    selectGroup.appendChild(label);
    selectGroup.appendChild(select);
    container.appendChild(selectGroup);
    
    console.log(`Added attribute selector for ${attributeKey}`);
    
    // Add an event listener to highlight when changed
    select.addEventListener('change', function() {
        if (this.value) {
            this.style.borderColor = '#36b37e';
            setTimeout(() => {
                this.style.borderColor = '#dfe1e6';
            }, 1500);
        }
    });
}

// Get selected work attributes for time logging
function getSelectedWorkAttributes() {
    const attributes = [];
    const selects = document.querySelectorAll('.attribute-select');
    
    selects.forEach(select => {
        if (select.value) {
            attributes.push({
                key: select.dataset.key,
                value: select.value
            });
        }
    });
    
    return attributes;
}

// Check if all required attributes are selected
function validateWorkAttributes() {
    let valid = true;
    const requiredSelects = document.querySelectorAll('.attribute-select[required]');
    
    requiredSelects.forEach(select => {
        if (!select.value) {
            select.style.border = '1px solid #ff5630';
            valid = false;
        } else {
            select.style.border = '1px solid #dfe1e6';
        }
    });
    
    return valid;
}

// Debug function to check workAttributes data
function debugWorkAttributes() {
    console.log('Current work attributes data:', workAttributes);
    
    if (Object.keys(workAttributes).length === 0) {
        console.warn('Work attributes data is empty!');
    }
    
    if (workAttributes['_TimeCategory_']) {
        console.log('Time Type attribute found with', 
                    workAttributes['_TimeCategory_'].values.length, 'values');
    } else {
        console.warn('Time Type attribute (_TimeCategory_) not found!');
    }
    
    if (workAttributes['_TechnologyTimeType_']) {
        console.log('Technology Time Type attribute found with', 
                    workAttributes['_TechnologyTimeType_'].values.length, 'values');
    } else {
        console.warn('Technology Time Type attribute (_TechnologyTimeType_) not found!');
    }
}

// Debug work attributes after page load
document.addEventListener('DOMContentLoaded', function() {
    // Debug after 2 seconds
    setTimeout(debugWorkAttributes, 2000);
});
