PRAGMA foreign_keys = ON;

-- Exact-byte image deduplication for the protected community uploader.
-- Community screenshots are written through one R2 put (not multipart), whose
-- R2 ETag is the lowercase 32-character MD5 of the stored object. The Worker
-- verifies that shape before persisting it here; historical rows remain NULL
-- until their existing R2 ETags are backfilled.
--
-- The partial unique index is the final concurrency guard: upload/finalize do
-- friendly indexed lookups first, while simultaneous finalizations cannot both
-- commit the same exact image. NULL keeps legacy/external images readable and
-- editable when no trustworthy R2 MD5 is available.
ALTER TABLE question_image_index
ADD COLUMN image_md5 TEXT
CHECK (
  image_md5 IS NULL OR (
    length(image_md5) = 32
    AND image_md5 NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS question_image_index_md5_unique
  ON question_image_index(image_md5)
  WHERE image_md5 IS NOT NULL;
