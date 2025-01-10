// To learn how to use this script, refer to the documentation:
// https://developers.google.com/apps-script/samples/automations/vacation-calendar

/*
Copyright 2022 Google LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Set the ID of the team calendar to add events to. You can find the calendar's
// ID on the settings page.
let TEAM_CALENDAR_ID = 'ENTER_TEAM_CALENDAR_ID_HERE';
// Set the email address of the Google Group that contains everyone in the team.
// Ensure the group has less than 500 members to avoid timeouts.
// Change to an array in order to add indirect members frrm multiple groups, for example:
// let GROUP_EMAIL = ['ENTER_GOOGLE_GROUP_EMAIL_HERE', 'ENTER_ANOTHER_GOOGLE_GROUP_EMAIL_HERE'];
let GROUP_EMAIL = 'ENTER_GOOGLE_GROUP_EMAIL_HERE';

let ONLY_DIRECT_MEMBERS = false;

let MONTHS_IN_ADVANCE = 3;

/**
 * Sets up the script to run automatically every hour.
 */
function setup() {
  let triggers = ScriptApp.getProjectTriggers();
  if (triggers.length > 0) {
    throw new Error('Triggers are already setup.');
  }
  ScriptApp.newTrigger('sync').timeBased().everyHours(1).create();
  // Runs the first sync immediately.
  sync();
}

/**
 * Looks through the group members' public calendars and adds any
 * 'vacation' or 'out of office' events to the team calendar.
 */
function sync() {
  // Defines the calendar event date range to search.
  let today = new Date();
  let maxDate = new Date();
  maxDate.setMonth(maxDate.getMonth() + MONTHS_IN_ADVANCE);

  // Determines the time the the script was last run.
  let lastRun = PropertiesService.getScriptProperties().getProperty('lastRun');
  lastRun = lastRun ? new Date(lastRun) : null;

  // Gets the list of users in the Google Group.
  let users = getAllMembers(GROUP_EMAIL);
  if (ONLY_DIRECT_MEMBERS){
    users = GroupsApp.getGroupByEmail(GROUP_EMAIL).getUsers();
  } else if (Array.isArray(GROUP_EMAIL)) {
    users = getUsersFromGroups(GROUP_EMAIL);
  }

  // For each user, finds events wich type is `outOfOffice`
  // summary in the specified date range. Imports each of those to the team
  // calendar.
  let count = 0;
  users.forEach(function(user) {
    let username = user.getUsername();
    let events = findEvents(user, today, maxDate, lastRun);
      events.forEach(function(event) {
        importEvent(username, event);
        count++;
      }); // End foreach event.
  }); // End foreach user.
  
  PropertiesService.getScriptProperties().setProperty('lastRun', today);
  console.log('Imported ' + count + ' events');
}

/**
 * Imports the given event from the user's calendar into the shared team
 * calendar.
 * @param {string} username The team member that is attending the event.
 * @param {Calendar.Event} event The event to import.
 */
function importEvent(username, event) {
  let originalSummary = event.summary;
  event.summary = '[' + username + '] ' + event.summary;
  event.organizer = {
    id: TEAM_CALENDAR_ID,
  };
  event.attendees = [];

  // If the event is not of type 'default', it can't be imported, so it needs
  // to be changed.
  if (event.eventType != 'default') {
    event.eventType = 'default';
    delete event.outOfOfficeProperties;
    delete event.focusTimeProperties;
  }

  console.log('Importing: %s', event.summary);
  try {
    Calendar.Events.import(event, TEAM_CALENDAR_ID);
    sendSlackNotification(username, event);
  } catch (e) {
    console.error('Error attempting to import event: %s. Skipping.',
        e.toString());
  }
}

/**
 * Sends a notification to Slack about the new calendar event.
 * @param {string} username The team member's username.
 * @param {Calendar.Event} event The calendar event details.
 * @param {string} originalSummary is the original summary of the event.
 */
function sendSlackNotification(username, event, originalSummary) {
  const SLACK_WEBHOOK_URL = 'YOUR_SLACK_WEBHOOK_URL';
  
  // Format dates to match the required format (YYYY/MM/DD AM/PM H:MM)
  function formatDate(dateString) {
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const hour12 = hours % 12 || 12;
    
    return `${year}/${month}/${day} ${ampm} ${hour12}:${minutes}`;
  }

  // Prepare the payload for Slack
  const payload = {
    user_name: username,
    summary: event.summary.replace(`[${username}] `, ''), // Remove the username prefix
    start: formatDate(event.start.dateTime),
    end: formatDate(event.end.dateTime)
  };

  // Send the webhook request
  try {
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload)
    };
    
    const response = UrlFetchApp.fetch(SLACK_WEBHOOK_URL, options);
    if (response.getResponseCode() !== 200) {
      console.error('Failed to send Slack notification. Status code:', response.getResponseCode());
    }
  } catch (e) {
    console.error('Error sending Slack notification:', e.toString());
  }
}

/**
 * In a given user's calendar, looks for occurrences of the given keyword
 * in events within the specified date range and returns any such events
 * found.
 * @param {Session.User} user The user to retrieve events for.
 * @param {Date} start The starting date of the range to examine.
 * @param {Date} end The ending date of the range to examine.
 * @param {Date} optSince A date indicating the last time this script was run.
 * @return {Calendar.Event[]} An array of calendar events.
 */
function findEvents(user, start, end, optSince) {
  let params = {
    timeMin: formatDateAsRFC3339(start),
    timeMax: formatDateAsRFC3339(end),
    showDeleted: true,
    eventTypes: "outOfOffice"
  };
  if (optSince) {
    // This prevents the script from examining events that have not been
    // modified since the specified date (that is, the last time the
    // script was run).
    params.updatedMin = formatDateAsRFC3339(optSince);
  }
  let pageToken = null;
  let events = [];
  do {
    params.pageToken = pageToken;
    let response;
    try {
      response = Calendar.Events.list(user.getEmail(), params);
    } catch (e) {
      console.error('Error retriving events for %s: %s; skipping', user, e.toString());
      continue;
    }
    events = events.concat(response.items.filter(function(item) {
      return shouldImportEvent(user, item);
    }));
    pageToken = response.nextPageToken;
  } while (pageToken);
  return events;
}

/**
 * Determines if the given event should be imported into the shared team
 * calendar.
 * @param {Session.User} user The user that is attending the event.
 * @param {Calendar.Event} event The event being considered.
 * @return {boolean} True if the event should be imported.
 */
function shouldImportEvent(user, event) {
  if (!event.organizer || event.organizer.email == user.getEmail()) {
    // If the user is the creator of the event, always imports it.
    return true;
  }
  // Only imports events the user has accepted.
  if (!event.attendees) return false;
  let matching = event.attendees.filter(function(attendee) {
    return attendee.self;
  });
  return matching.length > 0 && matching[0].responseStatus == 'accepted';
}

/**
 * Returns an RFC3339 formated date String corresponding to the given
 * Date object.
 * @param {Date} date a Date.
 * @return {string} a formatted date string.
 */
function formatDateAsRFC3339(date) {
  return Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd\'T\'HH:mm:ssZ');
}

/**
* Get both direct and indirect members (and delete duplicates).
* @param {string} the e-mail address of the group.
* @return {object} direct and indirect members.
*/
function getAllMembers(groupEmail) {
  var group = GroupsApp.getGroupByEmail(groupEmail);
  var users = group.getUsers();
  var childGroups = group.getGroups();
  for (var i = 0; i < childGroups.length; i++) {
    var childGroup = childGroups[i];
    users = users.concat(getAllMembers(childGroup.getEmail()));
  }
  // Remove duplicate members
  var uniqueUsers = [];
  var userEmails = {};
  for (var i = 0; i < users.length; i++) {
    var user = users[i];
    if (!userEmails[user.getEmail()]) {
      uniqueUsers.push(user);
      userEmails[user.getEmail()] = true;
    }
  }
  return uniqueUsers;
}

/**
* Get indirect members from multiple groups (and delete duplicates).
* @param {array} the e-mail addresses of multiple groups.
* @return {object} indirect members of multiple groups.
*/
function getUsersFromGroups(groupEmails) {
  let users = [];
  for (let groupEmail of groupEmails) {
    let groupUsers = GroupsApp.getGroupByEmail(groupEmail).getUsers();
    for (let user of groupUsers) {
      if (!users.some(u => u.getEmail() === user.getEmail())) {
        users.push(user);
      }
    }
  }
  return users;
}
