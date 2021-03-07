# jobd

**jobd** is a simple job queue daemon written in Node.JS. It uses MySQL table as
a storage.


## Installation

To be written


## Usage

To be written


## MySQL setup

Minimal table scheme.

In a real world, you would to add need additional fields such as `job_name` or
`job_data`. 

```
CREATE TABLE `jobs` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `target` char(16) NOT NULL,
  `time_created` int(10) UNSIGNED NOT NULL,
  `time_started` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `time_finished` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `status` enum('waiting','manual','accepted','running','done','ignored') NOT NULL DEFAULT 'waiting',
  `result` enum('ok','fail') DEFAULT NULL,
  `return_code` tinyint(3) UNSIGNED DEFAULT NULL,
  `sig` char(10) DEFAULT NULL,
  `stdout` mediumtext DEFAULT NULL,
  `stderr` mediumtext DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `status_target_idx` (`status`, `target`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
```

For optimization purposes, you can turn `target` into `ENUM`. Also if 16 characters
for target is not enough for you, change it to fit your needs.


## Clients

#### PHP

[php-jobd-client](https://github.com/gch1p/php-jobd-client) (official)

## Protocol

### jobd requests

* **`poll(targets: string[])`** — get new tasks for specified `targets` from database.
  If `targets` argument is not specified, get tasks for all serving targets.
  
* **`pause(targets: string[])`** — pause execution of tasks of specified targets.
  If `targets` argument is not specified, pauses all targets.

* **`continue(targets: string[])`** — continue execution of tasks of specified targets.
  If `targets` argument is not specified, continues all targets.
  
* **`status()`** — returns status of internal queues and memory usage.

* **`run-manual(ids: int[])`** — enqueue and run jobs with specified IDs and
  `status` set to `manual`, and return results.

* **`set-target-concurrency(target: string, concurrency: int)`** — set concurrency
  of target `target`.

### jobd-master requests

* **`register-worker(targets: string[])`** — used by a jobd instance to register
  itself with master. You don't need it.
  
* **`poke(targets: string[])`** — send `poll` requests to all registered workers
  that serve specified `targets`.

* **`pause(targets: string[])`** — send `pause(targets)` requests to workers
  serving specified `targets`. If `targets` argument is not specified, sends
  `pause()` to all workers.

* **`continue(targets: string[])`** — send `continue(targets)` requests to workers
  serving specified `targets`. If `targets` argument is not specified, sends
  `continue()` to all workers.
  
* **`status(poll_workers=false: bool)`** — returns list of registered workers and
  memory usage. If `poll_workers` is true, sends `status()` request to all registered
  workers and includes their responses.

* **`run-manual(jobs: {id: int, target: string}[])`** — send `run-manual`
  requests to registered jobd instances serving specified targets, aggregate an
  return results.


## TODO

- graceful shutdown

## License

BSD-2c