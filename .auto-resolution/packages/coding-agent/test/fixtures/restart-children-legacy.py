"""Let the old Bun child become a zombie before the new image starts."""
import os
import sys
import time

time.sleep(.2)
os.execv(sys.argv[1], sys.argv[1:])
