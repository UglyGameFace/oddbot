// src/utils/dateFormatter.js

/**
 * Formats an ISO 8601 date string into a user-friendly format for a specific timezone.
 * @param {string} isoString The ISO 8601 date string from the database.
 * @param {string} timezone The IANA timezone name (e.g., 'America/New_York').
 * @returns {string} A formatted date and time string (e.g., "Fri 9/19, 8:30 PM EDT").
 */
export const formatGameTime = (isoString, timezone = 'America/New_York') => {
    try {
        const date = new Date(isoString);
        
        const options = {
            weekday: 'short',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            timeZone: timezone,
            timeZoneName: 'short',
        };
        
        return new Intl.DateTimeFormat('en-US', options).format(date);
    } catch (error) {
        console.error("Error formatting date:", isoString, error);
        return "Invalid time"; // Fallback for invalid date strings
    }
};
