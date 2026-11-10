# Data for offline scanners. Never run terraform apply.
resource "aws_s3_bucket" "lab_logs" {
  bucket = "touchstone-lab-logs"
  acl    = "public-read"
}

resource "aws_security_group" "lab_admin" {
  name = "lab-admin"
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
