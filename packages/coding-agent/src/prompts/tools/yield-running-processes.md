Terminal yield refused: this worker still owns running processes:
{{#each jobs}}
{{id}}: {{command}} (elapsed {{elapsed}})
{{/each}}
Wait for them to finish, or explicitly kill them with proc://<id>/kill or mark a service persist/detached with proc://<id>/mode, then yield again. A second terminal yield with the same processes still running is accepted with abandonedJobs; unfinished owner jobs are cancelled by task cleanup.
