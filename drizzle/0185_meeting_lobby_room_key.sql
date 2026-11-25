-- Final review F2: a guest let in through the waiting room joined the call as guest-<request id>, and the request id
-- is the secret the guest joins with, shown to everyone in the room. Each request now has its own random room key,
-- and each join's room identity is guest-<room key>-<random>, so Remove finds all of that guest's tabs. Null on
-- existing rows: a request without one gets it on its next join.
ALTER TABLE `meeting_lobby` ADD `room_key` text;
