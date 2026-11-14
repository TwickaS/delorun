# A stand-in for the S2 workspace image in the supervisor's Docker specs: C9's base by digest, whose bash, coreutils
# and /proc give the probe commands what the real image gives them. It is tagged under C9's repository name only
# in the local engine, for the length of a spec run.
FROM docker.io/library/debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
CMD ["sleep", "infinity"]
