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
  `slot` char(16) DEFAULT NULL,
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

For optimization purposes, you can turn fields `target` and `slot` into `ENUM`s.


## jobd requests

* **`poll(targets=[])`** — get new tasks for specified `targets` from database.
  If `targets` is empty or not specified, get tasks for all serving targets.
  
* **`status`** — returns status of internal queues and memory usage.

* **`run-manual(id)`** — enqueue and run job with specified `id` and `status` set to
  `manual` and return results. 
  

## jobd-master requests

* **`register-worker(targets)`** — used by a jobd instance to register itself
  with master. You don't need it.
  
* **`poke(targets)`** — send `poll` requests to all registered workers that serve
  specified `targets`.
  
* **`status`** — returns list of registered workers and memory usage.


## TODO

**jobd**:
- `pause(targets)` / `continue(targets)`
- `run-manual` with multiple jobs

**jobd-master**:
- `status(workers=true)`
- `pause(targets)` / `continue(targets)`

other:
- graceful shutdown
- remove password from logger dumps
- reload config at runtime
- jobctl


## License

BSD-2c