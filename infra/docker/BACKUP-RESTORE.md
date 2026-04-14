# Database Backup & Restore Guide

## Automated Backups

The `db-backup` container in `docker-compose.prod.yml` runs daily backups:

- **Schedule**: Every 24 hours (starts on container boot)
- **Format**: PostgreSQL custom format (`pg_dump -Fc`)
- **Storage**: MinIO bucket `revamp-backups/daily/YYYYMMDD/`
- **Retention**: Manual cleanup required (recommend 30-day policy)

## Manual Backup

```bash
# From the host machine
docker exec revamp-postgres-primary pg_dump -U revamp -Fc revamp > backup.dump

# With timestamp
docker exec revamp-postgres-primary pg_dump -U revamp -Fc revamp > "revamp-$(date +%Y%m%d-%H%M%S).dump"
```

## Restore from Backup

```bash
# 1. Stop the API to prevent writes
docker stop revamp-api-1

# 2. Drop and recreate the database
docker exec revamp-postgres-primary psql -U revamp -c "DROP DATABASE revamp;"
docker exec revamp-postgres-primary psql -U revamp -c "CREATE DATABASE revamp;"

# 3. Restore from dump
cat backup.dump | docker exec -i revamp-postgres-primary pg_restore -U revamp -d revamp --no-owner

# 4. Restart the API
docker start revamp-api-1
```

## Restore from MinIO

```bash
# Download the backup from MinIO
curl -o backup.dump \
  "http://minio:9000/revamp-backups/daily/20260410/revamp-20260410-020000.dump" \
  -u "minioadmin:password"

# Then follow the restore steps above
```

## Point-in-Time Recovery (PITR)

WAL archiving is enabled in `postgres-primary.conf`. WAL segments are archived to
`/var/lib/postgresql/wal_archive/` inside the container.

For PITR:
1. Stop PostgreSQL
2. Restore the base backup
3. Configure `recovery.conf` with `restore_command` and `recovery_target_time`
4. Start PostgreSQL — it replays WAL segments to the target time

## Verification

Test your backups regularly:

```bash
# Verify a backup file is valid
pg_restore --list backup.dump | head -20

# Restore to a test database
docker exec revamp-postgres-primary createdb -U revamp revamp_test
cat backup.dump | docker exec -i revamp-postgres-primary pg_restore -U revamp -d revamp_test --no-owner
docker exec revamp-postgres-primary dropdb -U revamp revamp_test
```
